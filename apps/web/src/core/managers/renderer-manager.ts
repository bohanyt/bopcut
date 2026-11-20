import type { EditorCore } from "@/core";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import type { ExportOptions, ExportResult } from "@/export";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { SceneExporter } from "@/services/renderer/scene-exporter";
import { buildScene } from "@/services/renderer/scene-builder";
import { createTimelineAudioBuffer } from "@/media/audio";
import { formatTimecode } from "opencut-wasm";
import { frameRateToFloat } from "@/fps/utils";
import { downloadBlob } from "@/utils/browser";
import { calculateTotalDuration } from "@/timeline";
import { lastFrameMediaTime } from "@/wasm";
import { holdMediaUrls } from "@/media/url-release";

type SnapshotResult =
	| { success: true; blob: Blob; filename: string }
	| { success: false; error: string };

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

	/**
	 * Exports the timeline as it is when this is called (read before the first wait, so later edits are
	 * not mixed in). Refused while another export runs.
	 */
	async exportProject(job: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		if (this.exportRunning) {
			return { success: false, error: "Another export is running; try again when it finishes" };
		}
		this.exportRunning = true;
		const releaseMedia = holdMediaUrls();
		this.notify();
		try {
			return await this.runExport(job);
		} finally {
			releaseMedia();
			this.exportRunning = false;
			this.notify();
		}
	}

	private async runExport({
		options,
		onProgress,
		onCancel,
	}: {
		options: ExportOptions;
		onProgress?: ({ progress }: { progress: number }) => void;
		onCancel?: () => boolean;
	}): Promise<ExportResult> {
		const { format, quality, fps, includeAudio, sceneId } = options;

		try {
			const scenes = this.editor.scenes.getScenes();
			const active = this.editor.scenes.getActiveScene();
			const exported = sceneId ? scenes.find((scene) => scene.id === sceneId) : active;
			if (!exported) {
				return { success: false, error: "Scene not found" };
			}
			const tracks = exported.tracks;
			const mediaAssets = this.editor.media.getAssets();
			const activeProject = this.editor.project.getActive();

			if (!activeProject) {
				return { success: false, error: "No active project" };
			}

			const duration = exported.id === active.id ? this.editor.timeline.getTotalDuration() : calculateTotalDuration({ tracks });
			if (duration === 0) {
				return { success: false, error: "Project is empty" };
			}

			const exportFps = fps ?? activeProject.settings.fps;
			const canvasSize = activeProject.settings.canvasSize;

			let audioBuffer: AudioBuffer | null = null;
			if (includeAudio) {
				onProgress?.({ progress: 0.05 });
				audioBuffer = await createTimelineAudioBuffer({
					tracks,
					mediaAssets,
					duration,
					scenes,
				});
			}

			// Checked again before encoding: preparing the sound can take a while.
			if (onCancel?.()) {
				return { success: false, cancelled: true };
			}

			const scene = buildScene({
				tracks,
				mediaAssets,
				duration,
				canvasSize,
				background: activeProject.settings.background,
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
			});

			exporter.on("progress", (progress) => {
				const adjustedProgress = includeAudio
					? 0.05 + progress * 0.95
					: progress;
				onProgress?.({ progress: adjustedProgress });
			});

			let cancelled = false;
			const checkCancel = () => {
				if (onCancel?.()) {
					cancelled = true;
					exporter.cancel();
				}
			};

			const cancelInterval = setInterval(checkCancel, 100);

			try {
				const buffer = await exporter.export({ rootNode: scene });
				clearInterval(cancelInterval);

				// Also a cancel that came after the last check (a short export ends within 100 ms).
				if (cancelled || onCancel?.()) {
					return { success: false, cancelled: true };
				}

				if (!buffer) {
					return { success: false, error: "Export failed to produce buffer" };
				}

				return {
					success: true,
					buffer,
				};
			} finally {
				clearInterval(cancelInterval);
			}
		} catch (error) {
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
