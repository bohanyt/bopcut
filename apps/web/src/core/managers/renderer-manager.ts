import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportResult } from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { buildScene, collectVisibleMedia } from "@/services/renderer/scene-builder";
import { collectAudibleCandidates, createTimelineAudioBuffer } from "@/media/audio";
import type { MediaLoadFailure, MediaType } from "@/media/types";
import { formatTimecode } from "opencut-wasm";
import { downloadBlob } from "@/utils/browser";
import { calculateTotalDuration, type TScene } from "@/timeline";
import { isElementMuted } from "@/timeline/audio-state";
import type { TCanvasSize } from "@/project/types";
import { lastFrameMediaTime } from "@/wasm";
import { holdMediaUrls } from "@/media/url-release";
import { waitWithAbort } from "@/utils/abort";

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

function unavailableMedia(missingMedia: MediaLoadFailure[]): ExportResult {
	return { success: false, error: "Some media used in this timeline are unavailable.", missingMedia };
}

export class RendererManager {
	private renderTree: RootNode | null = null;
	private _isDegraded = false;
	private exportRunning = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	get isDegraded(): boolean {
		return this._isDegraded;
	}

	setDegraded(degraded: boolean): void {
		if (this._isDegraded === degraded) return;
		this._isDegraded = degraded;
		this.notify();
	}

	setRenderTree({ renderTree }: { renderTree: RootNode | null }): void {
		this.renderTree = renderTree;
		this.notify();
	}

	getRenderTree(): RootNode | null {
		return this.renderTree;
	}

	async saveSnapshot(): Promise<{ success: boolean; error?: string }> {
		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		downloadBlob({ blob: snapshot.blob, filename: snapshot.filename });
		return { success: true };
	}

	async copySnapshot(): Promise<{ success: boolean; error?: string }> {
		if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
			return {
				success: false,
				error: "Clipboard image copy is not supported in this browser",
			};
		}

		const snapshot = await this.createSnapshot();
		if (!snapshot.success) {
			return snapshot;
		}

		try {
			await navigator.clipboard.write([
				new ClipboardItem({
					[snapshot.blob.type || "image/png"]: snapshot.blob,
				}),
			]);
			return { success: true };
		} catch (error) {
			console.error("Copy snapshot failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/** Renders the open scene at `time` (default: playhead), or another scene's timeline when `sceneId` is given. */
	/** `scenes`: render that timeline state instead of the editor's (for example a past one). */
	async createSnapshot({ time, sceneId, scenes: given, settings }: { time?: import("@/wasm").MediaTime; sceneId?: string; scenes?: import("@/timeline").TScene[]; settings?: Pick<import("@/project/types").TProjectSettings, "canvasSize" | "background" | "fps"> } = {}): Promise<SnapshotResult> {
		try {
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No project or scene to capture" };
			}

			const active = this.editor.scenes.getActiveScene();
			const scenes = given ?? this.editor.scenes.getScenes();
			const scene = sceneId ? scenes.find((s) => s.id === sceneId) : given ? undefined : active;
			if (!scene) {
				return { success: false, error: "Scene not found" };
			}
			const isOpen = !given && scene.id === active.id;
			const duration = isOpen
				? this.editor.timeline.getTotalDuration()
				: calculateTotalDuration({ tracks: scene.tracks });
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const { canvasSize, fps, background } = settings ?? activeProject.settings;
			const renderTree = buildScene({
				tracks: isOpen ? (this.editor.timeline.getPreviewTracks() ?? active.tracks) : scene.tracks,
				mediaAssets: this.editor.media.getAssets(),
				duration,
				canvasSize,
				background,
				scenes,
			});
			const renderTime = Math.min(
				time ?? this.editor.playback.getCurrentTime(),
				isOpen ? this.editor.timeline.getLastFrameTime() : lastFrameMediaTime({ duration, fps }),
			);

			const renderer = new CanvasRenderer({
				width: canvasSize.width,
				height: canvasSize.height,
				fps,
				exactFrames: true,
			});

			const tempCanvas = document.createElement("canvas");
			tempCanvas.width = canvasSize.width;
			tempCanvas.height = canvasSize.height;

			await renderer.renderToCanvas({
				node: renderTree,
				time: renderTime,
				targetCanvas: tempCanvas,
			});

			const blob = await new Promise<Blob | null>((resolve) => {
				tempCanvas.toBlob((result) => resolve(result), "image/png");
			});

			if (!blob) {
				return { success: false, error: "Failed to create image" };
			}

			const timecode = formatTimecode({ time: renderTime, rate: fps })!.replace(/:/g, "-");
			const safeName =
				activeProject.metadata.name.replace(/[<>:"/\\|?*]/g, "-").trim() ||
				"snapshot";
			const filename = `${safeName}-${timecode}.png`;

			return { success: true, blob, filename };
		} catch (error) {
			console.error("Snapshot capture failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/** Whether an export (the user's or an agent's) is running: one runs at a time. */
	isExportRunning(): boolean {
		return this.exportRunning;
	}

	/** Checks a loaded scene before mixdown or rendering. */
	checkExport({
		format, allowMissing, includeAudio, scene, scenes, canvasSize, duration = calculateTotalDuration({ tracks: scene.tracks }),
	}: Pick<ExportOptions, "format" | "allowMissing" | "includeAudio"> & {
		scene: TScene;
		scenes: TScene[];
		canvasSize: TCanvasSize;
		duration?: number;
	}): ExportResult | null {
		if (format === "mp4" && (canvasSize.width % 2 !== 0 || canvasSize.height % 2 !== 0)) {
			return {
				success: false,
				error: `MP4 needs even canvas dimensions (${canvasSize.width} × ${canvasSize.height}). Choose WebM or set both dimensions to even numbers in project settings.`,
			};
		}
		if (allowMissing === true) return null;
		const { tracks } = scene;
		const { media } = this.editor;
		const visual = collectVisibleMedia({ tracks, scenes, duration })
			.map(({ mediaId, name, type }) => ({ id: mediaId, name, requiresUrl: true, types: [type] }));
		const audio = includeAudio ? collectAudibleCandidates({
			tracks, scenes, duration, mediaAssets: media.getAssets(), includeMissingVideo: true,
			silentMissingVideoIds: new Set(media.getMissingMedia().filter(({ hasAudio }) => hasAudio === false).map(({ id }) => id)),
		}).flatMap(({ element }) => {
			if (isElementMuted({ element })) return [];
			if (element.type === "audio" && element.sourceType !== "upload") return [];
			const types: MediaType[] = element.type === "video" ? ["video"] : ["audio", "video"];
			return [{ id: element.mediaId, name: element.name, types }];
		}) : [];
		const missingMedia = media.getMissingReferences([...visual, ...audio]);
		return missingMedia.length ? unavailableMedia(missingMedia) : null;
	}

	/**
	 * Exports the timeline as it is when this is called. If media are still loading, only the media
	 * snapshot waits. Refused while another export runs.
	 */
	async exportProject(job: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		signal?: AbortSignal;
	}): Promise<ExportResult> {
		if (this.exportRunning) {
			return { success: false, error: "Another export is running; try again when it finishes" };
		}
		const sessionSignal = this.editor.project.getSessionSignal();
		const signal = job.signal ? AbortSignal.any([job.signal, sessionSignal]) : sessionSignal;
		const releaseMedia = holdMediaUrls();
		this.exportRunning = true;
		try {
			this.notify();
			return await this.runExport({ ...job, signal });
		} finally {
			this.exportRunning = false;
			try {
				releaseMedia();
			} finally {
				this.notify();
			}
		}
	}

	private async runExport({
		options,
		onProgress,
		signal: callerSignal,
	}: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		signal: AbortSignal;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio, sceneId, allowMissing } = options;
		const visualFailure = new AbortController();
		const signal = AbortSignal.any([callerSignal, visualFailure.signal]);
		const failures = new Map<string, MediaLoadFailure>();

		try {
			signal.throwIfAborted();
			const scenes = this.editor.scenes.getScenes();
			const active = this.editor.scenes.getActiveScene();
			const exported = sceneId ? scenes.find((scene) => scene.id === sceneId) : active;
			if (!exported) {
				return { success: false, error: "Scene not found" };
			}
			const tracks = exported.tracks;
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = exported.id === active.id ? this.editor.timeline.getTotalDuration() : calculateTotalDuration({ tracks });
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const { canvasSize, background } = activeProject.settings;

			const { media } = this.editor;
			if (media.isLoadingMedia()) {
				await new Promise<void>((resolve) => {
					const finish = () => {
						unsubscribeMedia();
						signal.removeEventListener("abort", finish);
						resolve();
					};
					const unsubscribeMedia = media.subscribe(() => {
						if (!media.isLoadingMedia()) finish();
					});
					signal.addEventListener("abort", finish, { once: true });
				});
			}
			signal.throwIfAborted();

			const preflight = this.checkExport({ format, allowMissing, includeAudio, scene: exported, scenes, canvasSize, duration });
			if (preflight) return preflight;
			const mediaAssets = media.getAssets();

			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio) {
				onProgress?.({ progress: 0.05 });
				signal.throwIfAborted();
				audioBuffer = await waitWithAbort(createTimelineAudioBuffer({
					tracks, mediaAssets, duration, scenes, signal,
					onFailure: (failure) => failures.set(failure.id, failure),
				}), signal);
			}

			signal.throwIfAborted();
			if (failures.size && allowMissing !== true) return unavailableMedia([...failures.values()]);

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background,
				scenes,
			});

			const exporter = new SceneExporter({
				width: canvasSize.width,
				height: canvasSize.height,
				fps: exportFps,
				format,
				quality,
				shouldIncludeAudio: !!includeAudio,
				audioBuffer: audioBuffer || undefined,
				onMediaFailure: (id, error) => {
					const name = mediaAssets.find((asset) => asset.id === id)?.name ?? id;
					failures.set(id, { id, name, error: error instanceof Error ? error.message : String(error), unreadable: true });
					if (allowMissing !== true) visualFailure.abort();
				},
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = includeAudio
					? 0.05 + progress * 0.95
					: progress;
				onProgress?.({ progress: adjustedProgress });
			});

			const buffer = await exporter.export({ rootNode: scene, signal });
			signal.throwIfAborted();

			if (!buffer) {
				return { success: false, error: "Export failed to produce buffer" };
			}

			return { success: true, buffer };
		} catch (error) {
			if (callerSignal.aborted) return { success: false, cancelled: true };
			if (visualFailure.signal.aborted) return unavailableMedia([...failures.values()]);
			console.error("Export failed:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown export error",
			};
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
