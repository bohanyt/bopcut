import { EditorCore } from "@/core";
import { calculateTotalDuration, type TimelineElement } from "@/timeline";
import { lastFrameMediaTime, mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import type { MediaLoadFailure } from "@/media/types";
import { getRendererLimits, isGraphicsInitializing, rendererDevice } from "@/services/renderer/renderer-device";
import { fitSurfaceSize } from "@/services/renderer/scale";
import { getRootScene } from "./scene-graph";
import { isForOtherProject, parseStateRef, resolveState, type TimelineState } from "./history";
import { markAnswered, wasAnswered } from "./answered";
import { readRenderRequest, renderTransport, type RenderFetch, type RenderTransport } from "./render-transport";
import { MAX_FRAMES } from "./render-input";
import { noteId } from "./notes";
import type { BookmarkBox } from "@/timeline/bookmarks/area";

export { MAX_FRAMES } from "./render-input";

/**
 * The timeline states a frames request renders: `state` (default: the timeline now) and, with `compare`,
 * a second state at the same times (before/after pairs). A message when a state is unknown or malformed.
 */
export function framesStates(request: { state?: unknown; compare?: unknown }, projectId: string): { state: TimelineState | null; compare: TimelineState | null } | string {
	const pick = (value: unknown, name: string): TimelineState | null | string => {
		if (value === undefined) return null;
		const ref = parseStateRef(value);
		if (!ref) return `${name} must be {syncedAt} or {draft, side: "before"|"after"}`;
		return resolveState(ref, projectId);
	};
	const state = pick(request.state, "state");
	if (typeof state === "string") return state;
	const compare = pick(request.compare, "compare");
	if (typeof compare === "string") return compare;
	return { state, compare };
}

let busy = false;
let refusedMissing: string | null = null;
type PendingCancellation = { rev: string; projectId: string; key: string; send: RenderFetch };
let pendingCancellation: PendingCancellation | null = null;

function postFramesResult({ rev, projectId, send }: { rev: string; projectId: string; send: RenderFetch }, body: Record<string, unknown>) {
	return send("/api/agent/frames-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rev, projectId, ...body }) });
}

async function postCancellation(cancellation: PendingCancellation) {
	const response = await postFramesResult(cancellation, { files: [], error: "cancelled: the project session changed during the frame request" });
	if (response.ok) {
		markAnswered(cancellation.key, cancellation.rev);
		pendingCancellation = null;
	}
}

/** Reads and renders a frame request against one project session and a fixed timeline for each pass. */
export async function pollFrames(readiness: () => { ready: boolean; missingMedia: MediaLoadFailure[] }, source?: Response, transport?: RenderTransport) {
	const editor = EditorCore.getInstance();
	const before = editor.project.getActiveOrNull();
	if (busy || (editor.renderOnly && !source)) return;
	if (!pendingCancellation && (!before || editor.timeline.isPreviewActive() || isGraphicsInitializing() || !readiness().ready)) return;
	const session = editor.project.getSessionSignal();
	busy = true;
	try {
		const response = source ?? await readRenderRequest("frames", before?.metadata.id ?? "", !pendingCancellation);
		const request = await response.json() as {
			rev?: string; times?: unknown; elements?: string[]; noteId?: string; sceneId?: string; width?: number; projectId?: unknown; allowMissing?: boolean; state?: unknown; compare?: unknown;
		} | null;
		if (!request || typeof request.rev !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.rev)) return;
		// The workspace has a single result file. Retry a failed cancellation while its request is current.
		if (pendingCancellation) {
			if (request.rev === pendingCancellation.rev) return await postCancellation(pendingCancellation);
			pendingCancellation = null;
		}
		const { request: send, signal: jobSignal, reportStage } = transport ?? renderTransport(response);
		const signal = jobSignal ? AbortSignal.any([session, jobSignal]) : session;
		const elements = jobSignal ? request.elements : undefined;
		const requestedNote = typeof request.noteId === "string" && request.noteId.length > 0;
		if (!elements && !requestedNote && (!Array.isArray(request.times) || !request.times.length || request.times.some((t: unknown) => typeof t !== "number" || !Number.isFinite(t) || t < 0))) return;
		if (request.width !== undefined && (!Number.isInteger(request.width) || request.width < 1 || request.width > 4096)) return;
		// A request read across a session switch has not been picked up by either project yet.
		const project = editor.project.getActiveOrNull();
		if (!project || session.aborted || editor.timeline.isPreviewActive() || isGraphicsInitializing() || !readiness().ready) {
			if (jobSignal && before) await postFramesResult({ rev: request.rev, projectId: before.metadata.id, send }, { files: [], error: "The editor changed before taking the frame request. Retry." });
			return;
		}
		const { ready, missingMedia } = readiness();
		if (!ready) return;
		const projectId = project.metadata.id;
		const { rev, width } = request;
		const key = `agent-frames-${projectId}`;
		if ((!editor.renderOnly && wasAnswered(key, rev)) || isForOtherProject(request, [request.state, request.compare], projectId)) return;
		// An unscoped request answered across a switch must not start over in the newly opened project.
		const switchKey = typeof request.projectId === "string" ? key : "agent-frames-answered-on-switch";
		if (!editor.renderOnly && switchKey !== key && wasAnswered(switchKey, rev)) return;
		const result = (body: Record<string, unknown>) => postFramesResult({ rev, projectId, send }, body);
		const cancel = () => {
			if (jobSignal) return jobSignal.aborted ? undefined : result({ files: [], error: "cancelled: the project session changed during the frame request" });
			pendingCancellation = { rev, projectId, key: switchKey, send };
			return postCancellation(pendingCancellation);
		};
		const finish = async (body: Record<string, unknown>) => {
			try {
				const response = await result(body);
				if (!response.ok) throw new Error(await response.text());
			} catch (error) {
				if (signal.aborted) return await cancel();
				throw error;
			}
			if (!editor.renderOnly) markAnswered(signal.aborted ? switchKey : key, rev);
		};
		const refuse = (error: string) => finish({ files: [], error });
		if (missingMedia.length && request.allowMissing !== true) {
			// The same request may run after the missing assets have been reloaded.
			const missingKey = JSON.stringify([projectId, rev]);
			if (refusedMissing !== missingKey && (await result({ files: [], missingMedia, error: `${missingMedia.length} stored media could not be loaded; retry them (window.agent.retryMissingMedia()) or send allowMissing:true` })).ok) {
				refusedMissing = missingKey;
			}
			return;
		}
		const states = framesStates(request, projectId);
		if (typeof states === "string") return await refuse(states);
		const scenes = editor.scenes.getScenes();
		const activeSceneId = editor.scenes.getActiveSceneOrNull()?.id ?? null;
		const assets = editor.media.getAssets();
		const { canvasSize, background, fps } = project.settings;
		const settings = { canvasSize, background, fps };
		const root = getRootScene(scenes, activeSceneId);
		const times = requestedNote ? [] : (request.times as number[] ?? []);
		if (elements) {
			const items = root ? [...root.tracks.overlay, root.tracks.main, ...root.tracks.audio].flatMap<TimelineElement>((track) => track.elements) : [];
			for (const id of elements) {
				const matches = items.filter((item) => item.id === id || item.agentId === id);
				if (matches.length !== 1) return await refuse(`Expected one root timeline element matching ${id}, found ${matches.length}.`);
				times.push(matches[0].startTime / TICKS_PER_SECOND);
			}
		}
		let live: TimelineState | null = root ? { projectId, scenes, rootSceneId: root.id, settings, media: new Map(assets.map((asset) => [asset.id, asset.name])) } : null;
		let primary = states.state ?? live;
		if (!primary) return await refuse("No scene");
		let box: BookmarkBox | undefined;
		if (requestedNote) {
			if (request.times || elements || states.compare) return await refuse("Use noteId without times, elements or compare");
			const candidates = primary.scenes.filter((entry) => request.sceneId ? entry.id === request.sceneId : true)
				.flatMap((scene) => scene.bookmarks.filter((b) => noteId(b) === request.noteId && b.note?.trim()).map((bookmark) => ({ scene, bookmark })));
			if (candidates.length !== 1) return await refuse("Expected one note matching noteId; use sceneId to disambiguate");
			const [{ scene, bookmark }] = candidates;
			if (scene.id !== primary.rootSceneId) {
				const scoped = { ...primary, rootSceneId: scene.id };
				if (primary === live) live = scoped;
				primary = scoped;
			}
			times.push(bookmark.time / TICKS_PER_SECOND);
			box = bookmark.box;
		}
		const passes: [TimelineState, "compare"?][] = [[primary]];
		if (states.compare) passes.push([states.compare, "compare"]);
		if (times.length * passes.length > MAX_FRAMES) return await refuse(`at most ${MAX_FRAMES} frames per request (times x states)`);
		const missing = (state: TimelineState) => {
			if (state === live && editor.media.getAssets() === assets) return null;
			const removed = removedMedia(state, state === live);
			return removed.length ? `media used by that state were removed since, so its frames would not show them: ${removed.join(", ")}` : null;
		};
		for (const [state] of passes) {
			const error = missing(state);
			if (error) return await refuse(error);
		}
		const files: string[] = [];
		const compared: string[] = [];
		let crop: string | undefined;
		// A time a state cannot show (outside its timeline, or an empty one) is reported; the others go on.
		const errors: { time: number; variant?: string; error: string }[] = [];
		for (const [index, time] of times.entries()) {
			for (const [state, variant] of passes) {
				if (signal.aborted) return await cancel();
				try {
					reportStage?.(`rendering frame ${index + 1}/${times.length}`);
					const error = missing(state);
					if (error) throw new Error(error);
					const before = editor.media.getAssets();
					const captured = await renderFrame({
						request: { rev, width }, time, state, variant, box, settings: state.settings ?? settings, signal, send,
						checkMedia: () => editor.media.getAssets() === before ? null : missing(state),
					});
					(variant ? compared : files).push(captured.file);
					crop = captured.crop ?? crop;
				} catch (error) {
					if (editor.renderOnly && rendererDevice.status.state !== "ready") {
						return await refuse("Graphics became unavailable in the hidden browser. Open the editor once and retry.");
					}
					errors.push({ time, ...(variant ? { variant } : {}), error: error instanceof Error ? error.message : String(error) });
				}
			}
		}
		if (signal.aborted) return await cancel();
		await finish({ files, ...(crop && { crop, box }), ...(states.compare ? { compare: compared } : {}), ...(errors.length ? { errors } : {}) });
	} catch (error) { console.error("Agent frame failed:", error); }
	finally { busy = false; }
}

/**
 * Media a past state shows that are no longer in the project (their names): what its root timeline shows
 * on visible tracks, through visible compound clips (sounds, hidden tracks and other scenes do not show).
 */
export function removedMedia(state: TimelineState, onlyPreviouslyPresent = false): string[] {
	const present = new Set(EditorCore.getInstance().media.getAssets().map((asset) => asset.id));
	const byId = new Map(state.scenes.map((scene) => [scene.id, scene] as const));
	const names = new Set<string>();
	const visited = new Set<string>();
	const walk = (sceneId: string) => {
		const scene = byId.get(sceneId);
		if (!scene || visited.has(sceneId)) return;
		visited.add(sceneId);
		for (const track of [...scene.tracks.overlay, scene.tracks.main]) {
			if ((track as { hidden?: boolean }).hidden) continue;
			for (const element of track.elements) {
				if ((element as { hidden?: boolean }).hidden) continue;
				const mediaId = (element as { mediaId?: unknown }).mediaId;
				if (typeof mediaId === "string" && !present.has(mediaId) && (!onlyPreviouslyPresent || state.media?.has(mediaId))) {
					names.add(state.media?.get(mediaId) ?? mediaId);
				}
				const nested = (element as { sceneId?: unknown }).sceneId;
				if (element.type === "compound" && typeof nested === "string") walk(nested);
			}
		}
	};
	walk(state.rootSceneId);
	return [...names];
}

/** Renders and saves one frame from the state chosen for this pass. */
async function renderFrame({ request, time, state, variant, box, settings, signal, checkMedia, send }: {
	request: { rev: string; width?: number }; time: number; state: TimelineState; variant?: string;
	box?: BookmarkBox; settings: NonNullable<TimelineState["settings"]>; signal: AbortSignal; checkMedia: () => string | null; send: RenderFetch;
}): Promise<{ file: string; crop?: string }> {
	const { scenes, rootSceneId } = state;
	const root = scenes.find((scene) => scene.id === rootSceneId);
	if (!root) throw new Error("No scene");
	const ticks = mediaTimeFromSeconds({ seconds: time });
	const duration = calculateTotalDuration({ tracks: root.tracks });
	if (duration === 0) throw new Error("The timeline of that state is empty");
	if (ticks > lastFrameMediaTime({ duration, fps: settings.fps })) throw new Error(`Time outside timeline: ${time}`);
	const { maxSurfaceDimension = 4096 } = getRendererLimits();
	const image = await captureFrame({ ticks, sceneId: root.id, scenes, settings, signal, checkMedia });
	const canvas = document.createElement("canvas");
	let crop: HTMLCanvasElement | undefined;
	try {
		const requestedWidth = request.width ?? 960;
		const { width, height } = fitSurfaceSize(
			requestedWidth,
			(requestedWidth * image.height) / image.width,
			maxSurfaceDimension,
		);
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas unavailable");
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
		if (box) {
			crop = document.createElement("canvas");
			const sw = box.width * image.width, sh = box.height * image.height;
			const scale = Math.min(768, maxSurfaceDimension) / Math.max(sw, sh);
			crop.width = Math.max(1, Math.round(sw * scale));
			crop.height = Math.max(1, Math.round(sh * scale));
			const cropContext = crop.getContext("2d");
			if (!cropContext) throw new Error("Canvas unavailable");
			cropContext.drawImage(image, box.x * image.width, box.y * image.height, sw, sh, 0, 0, crop.width, crop.height);
			const rect = [box.x * width, box.y * height, box.width * width, box.height * height] as const;
			context.strokeStyle = "#111";
			context.lineWidth = 5;
			context.strokeRect(...rect);
			context.strokeStyle = "#67e8f9";
			context.lineWidth = 3;
			context.strokeRect(...rect);
		}
	} finally {
		image.close();
	}
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
	if (!blob) throw new Error("Failed to create JPEG");
	const form = new FormData();
	form.set("rev", request.rev); form.set("time", String(time)); form.set("image", blob);
	if (crop) {
		const jpeg = await new Promise<Blob | null>((resolve) => crop.toBlob(resolve, "image/jpeg", 0.9));
		if (!jpeg) throw new Error("Failed to create crop JPEG");
		form.set("crop", jpeg);
	}
	if (variant) form.set("variant", variant);
	signal.throwIfAborted();
	const response = await send("/api/agent/frame", { method: "POST", body: form, signal });
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function captureFrame({ ticks, sceneId, scenes, settings, signal, checkMedia }: {
	ticks: ReturnType<typeof mediaTimeFromSeconds>; sceneId: string; scenes: TimelineState["scenes"];
	settings: NonNullable<TimelineState["settings"]>; signal: AbortSignal; checkMedia?: () => string | null;
}) {
	signal.throwIfAborted();
	const snapshot = await EditorCore.getInstance().renderer.createSnapshot({ time: ticks, sceneId, scenes, settings });
	signal.throwIfAborted();
	const error = checkMedia?.();
	if (error) throw new Error(error);
	if (!snapshot.success) throw new Error(snapshot.error);
	return createImageBitmap(snapshot.blob);
}
