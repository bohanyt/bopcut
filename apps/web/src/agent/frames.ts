import { EditorCore } from "@/core";
import { calculateTotalDuration } from "@/timeline";
import { lastFrameMediaTime, mediaTimeFromSeconds } from "@/wasm";
import type { MediaLoadFailure } from "@/media/types";
import { getRootScene } from "./scene-graph";
import { isForOtherProject, parseStateRef, resolveState, type TimelineState } from "./history";
import { markAnswered, wasAnswered } from "./answered";

/** At most this many frames per request (times, doubled with `compare`). */
export const MAX_FRAMES = 64;

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
type PendingCancellation = { rev: string; projectId: string; key: string };
let pendingCancellation: PendingCancellation | null = null;

function postFramesResult({ rev, projectId }: { rev: string; projectId: string }, body: Record<string, unknown>) {
	return fetch("/api/agent/frames-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rev, projectId, ...body }) });
}

async function postCancellation(cancellation: PendingCancellation) {
	const response = await postFramesResult(cancellation, { files: [], error: "cancelled: the project session changed during the frame request" });
	if (response.ok) {
		markAnswered(cancellation.key, cancellation.rev);
		pendingCancellation = null;
	}
}

/** Reads and renders a frame request against one project session and a fixed timeline for each pass. */
export async function pollFrames(readiness: () => { ready: boolean; missingMedia: MediaLoadFailure[] }) {
	const editor = EditorCore.getInstance();
	if (busy) return;
	if (!pendingCancellation && (!editor.project.getActiveOrNull() || editor.timeline.isPreviewActive() || !readiness().ready)) return;
	const signal = editor.project.getSessionSignal();
	busy = true;
	try {
		const request = await (await fetch("/api/agent/frames-request", { cache: "no-store" })).json() as {
			rev?: string; times?: unknown; width?: number; projectId?: unknown; allowMissing?: boolean; state?: unknown; compare?: unknown;
		} | null;
		if (!request || typeof request.rev !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.rev)) return;
		// The workspace has a single result file. Retry a failed cancellation while its request is current.
		if (pendingCancellation) {
			if (request.rev === pendingCancellation.rev) return await postCancellation(pendingCancellation);
			pendingCancellation = null;
		}
		if (!Array.isArray(request.times) || !request.times.length || request.times.some((t: unknown) => typeof t !== "number" || !Number.isFinite(t) || t < 0) || (request.width !== undefined && (!Number.isInteger(request.width) || request.width < 1 || request.width > 4096))) return;
		// A request read across a session switch has not been picked up by either project yet.
		const project = editor.project.getActiveOrNull();
		if (!project || signal.aborted || editor.timeline.isPreviewActive()) return;
		const { ready, missingMedia } = readiness();
		if (!ready) return;
		const projectId = project.metadata.id;
		const { rev, width } = request;
		const key = `agent-frames-${projectId}`;
		if (wasAnswered(key, rev) || isForOtherProject(request, [request.state, request.compare], projectId)) return;
		// An unscoped request cancelled on a switch must not start over in the newly opened project.
		const cancelKey = typeof request.projectId === "string" ? key : "agent-frames-cancelled";
		if (cancelKey !== key && wasAnswered(cancelKey, rev)) return;
		const result = (body: Record<string, unknown>) => postFramesResult({ rev, projectId }, body);
		// A request that cannot be rendered is answered once with the reason, not retried every poll.
		const refuse = async (error: string) => {
			if ((await result({ files: [], error })).ok) markAnswered(key, rev);
		};
		const cancel = () => {
			pendingCancellation = { rev, projectId, key: cancelKey };
			return postCancellation(pendingCancellation);
		};
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
		const live = root ? { projectId, scenes, rootSceneId: root.id, settings, media: new Map(assets.map((asset) => [asset.id, asset.name])) } : null;
		const primary = states.state ?? live;
		if (!primary) return await refuse("No scene");
		const passes: [TimelineState, "compare"?][] = [[primary]];
		if (states.compare) passes.push([states.compare, "compare"]);
		if (request.times.length * passes.length > MAX_FRAMES) return await refuse(`at most ${MAX_FRAMES} frames per request (times x states)`);
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
		// A time a state cannot show (outside its timeline, or an empty one) is reported; the others go on.
		const errors: { time: number; variant?: string; error: string }[] = [];
		for (const time of request.times as number[]) {
			for (const [state, variant] of passes) {
				if (signal.aborted) return await cancel();
				try {
					const error = missing(state);
					if (error) throw new Error(error);
					const before = editor.media.getAssets();
					(variant ? compared : files).push(await renderFrame({
						request: { rev, width }, time, state, variant, settings: state.settings ?? settings, signal,
						checkMedia: () => editor.media.getAssets() === before ? null : missing(state),
					}));
				} catch (error) {
					errors.push({ time, ...(variant ? { variant } : {}), error: error instanceof Error ? error.message : String(error) });
				}
			}
		}
		if (signal.aborted) return await cancel();
		const response = await result({ files, ...(states.compare ? { compare: compared } : {}), ...(errors.length ? { errors } : {}) });
		if (!response.ok) throw new Error(await response.text());
		markAnswered(key, rev);
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
async function renderFrame({ request, time, state, variant, settings, signal, checkMedia }: {
	request: { rev: string; width?: number }; time: number; state: TimelineState; variant?: string;
	settings: NonNullable<TimelineState["settings"]>; signal: AbortSignal; checkMedia: () => string | null;
}): Promise<string> {
	const editor = EditorCore.getInstance();
	const { scenes, rootSceneId } = state;
	const root = scenes.find((scene) => scene.id === rootSceneId);
	if (!root) throw new Error("No scene");
	const ticks = mediaTimeFromSeconds({ seconds: time });
	const duration = calculateTotalDuration({ tracks: root.tracks });
	if (duration === 0) throw new Error("The timeline of that state is empty");
	if (ticks > lastFrameMediaTime({ duration, fps: settings.fps })) throw new Error(`Time outside timeline: ${time}`);
	const snapshot = await editor.renderer.createSnapshot({ time: ticks, sceneId: root.id, scenes, settings });
	signal.throwIfAborted();
	const error = checkMedia();
	if (error) throw new Error(error);
	if (!snapshot.success) throw new Error(snapshot.error);
	const image = await createImageBitmap(snapshot.blob);
	const canvas = document.createElement("canvas");
	try {
		canvas.width = request.width ?? 960;
		canvas.height = Math.max(1, Math.round(canvas.width * image.height / image.width));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas unavailable");
		context.drawImage(image, 0, 0, canvas.width, canvas.height);
	} finally {
		image.close();
	}
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
	if (!blob) throw new Error("Failed to create JPEG");
	const form = new FormData();
	form.set("rev", request.rev); form.set("time", String(time)); form.set("image", blob);
	if (variant) form.set("variant", variant);
	signal.throwIfAborted();
	const response = await fetch("/api/agent/frame", { method: "POST", body: form, signal });
	if (!response.ok) throw new Error(await response.text());
	return (await response.json()).file;
}
