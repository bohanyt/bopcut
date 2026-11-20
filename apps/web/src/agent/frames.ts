import { EditorCore } from "@/core";
import { calculateTotalDuration } from "@/timeline";
import { lastFrameMediaTime, mediaTimeFromSeconds } from "@/wasm";
import { getRootScene } from "./scene-graph";
import { isOtherProjects, parseStateRef, resolveState, type TimelineState } from "./history";
import { getSceneInstances } from "./scene-graph";
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
/** Renders a frames request: the one the readiness gate already read (`checked`), or else the current one. */
export async function pollFrames(checked?: unknown) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || busy || editor.timeline.isPreviewActive()) return;
	busy = true;
	try {
		const request = (checked ?? (await (await fetch("/api/agent/frames-request", { cache: "no-store" })).json())) as any;
		if (!request || typeof request.rev !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.rev) || !Array.isArray(request.times) || !request.times.length || request.times.some((t: unknown) => typeof t !== "number" || !Number.isFinite(t) || t < 0) || (request.width !== undefined && (!Number.isInteger(request.width) || request.width < 1 || request.width > 4096))) return;
		const key = `agent-frames-${project.metadata.id}`;
		if (wasAnswered(key, request.rev)) return;
		const result = (body: Record<string, unknown>) =>
			fetch("/api/agent/frames-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rev: request.rev, projectId: project.metadata.id, ...body }) });
		// A request that cannot be rendered is answered once with the reason, not retried every poll.
		const refuse = async (error: string) => {
			if ((await result({ files: [], error })).ok) markAnswered(key, request.rev);
		};
		// A request about another project (its snapshot or draft, or its projectId) is left for that project.
		if (typeof request.projectId === "string" && request.projectId !== project.metadata.id) return;
		for (const value of [request.state, request.compare]) {
			const ref = value === undefined ? null : parseStateRef(value);
			if (ref && isOtherProjects(ref, project.metadata.id)) return;
		}
		const states = framesStates(request, project.metadata.id);
		if (typeof states === "string") return await refuse(states);
		const passes = [[states.state, undefined], ...(states.compare ? [[states.compare, "compare"]] : [])] as [TimelineState | null, string | undefined][];
		if (request.times.length * passes.length > MAX_FRAMES) return await refuse(`at most ${MAX_FRAMES} frames per request (times x states)`);
		for (const [state] of passes) {
			const removed = state ? removedMedia(state) : [];
			if (removed.length) return await refuse(`media used by that state were removed since, so its frames would not show them: ${removed.join(", ")}`);
		}
		const files: string[] = [];
		const compared: string[] = [];
		// A time a state cannot show (outside its timeline, or an empty one) is reported; the others go on.
		const errors: { time: number; variant?: string; error: string }[] = [];
		for (const time of request.times as number[]) {
			for (const [state, variant] of passes) {
				if (editor.timeline.isPreviewActive() || editor.project.getActiveOrNull()?.metadata.id !== project.metadata.id) return;
				try {
					(variant ? compared : files).push(await renderFrame({ request, time, state, variant }));
				} catch (error) {
					errors.push({ time, ...(variant ? { variant } : {}), error: error instanceof Error ? error.message : String(error) });
				}
			}
		}
		const response = await result({ files, ...(states.compare ? { compare: compared } : {}), ...(errors.length ? { errors } : {}) });
		if (!response.ok) throw new Error(await response.text());
		markAnswered(key, request.rev);
	} catch (error) { console.error("Agent frame failed:", error); }
	finally { busy = false; }
}

/**
 * Media a past state shows that are no longer in the project (their names): visual tracks of its root
 * timeline and the compound clips in it (sounds and other scenes do not show in a frame).
 */
export function removedMedia(state: TimelineState): string[] {
	const present = new Set(EditorCore.getInstance().media.getAssets().map((asset) => asset.id));
	const names = new Set<string>();
	const shown = new Set([state.rootSceneId, ...getSceneInstances(state.scenes, state.rootSceneId, 1).keys()]);
	for (const scene of state.scenes.filter((candidate) => shown.has(candidate.id))) {
		for (const track of [...scene.tracks.overlay, scene.tracks.main]) {
			for (const element of track.elements) {
				const mediaId = (element as { mediaId?: unknown }).mediaId;
				if (typeof mediaId === "string" && !present.has(mediaId)) names.add(state.media?.get(mediaId) ?? mediaId);
			}
		}
	}
	return [...names];
}

/** Renders one frame of a state (null: the timeline now) and saves it; returns the saved file. */
async function renderFrame({ request, time, state, variant }: { request: { rev: string; width?: number }; time: number; state: TimelineState | null; variant?: string }): Promise<string> {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActive();
	// Frames show the root timeline (compound clips rendered with their content), also while the human is inside a compound.
	const scenes = state?.scenes ?? editor.scenes.getScenes();
	const root = state ? scenes.find((scene) => scene.id === state.rootSceneId) : getRootScene(scenes, editor.scenes.getActiveSceneOrNull()?.id ?? null);
	if (!root) throw new Error("No scene");
	const ticks = mediaTimeFromSeconds({ seconds: time });
	const duration = calculateTotalDuration({ tracks: root.tracks });
	const fps = state?.settings?.fps ?? project.settings.fps;
	// Checked right before each frame (the user can remove media during a long batch); the render reads
	// the media list in the same task, so nothing can change in between.
	const removed = state ? removedMedia(state) : [];
	if (removed.length) throw new Error(`media used by that state were removed since, so the frame would not show them: ${removed.join(", ")}`);
	if (duration === 0) throw new Error("The timeline of that state is empty");
	if (ticks > lastFrameMediaTime({ duration, fps })) throw new Error(`Time outside timeline: ${time}`);
	// A past state renders with the canvas, background and frame rate it had.
	const snapshot = await editor.renderer.createSnapshot({ time: ticks, sceneId: root.id, ...(state ? { scenes, settings: state.settings } : {}) });
	if (!snapshot.success) throw new Error(snapshot.error);
	const image = await createImageBitmap(snapshot.blob);
	const canvas = document.createElement("canvas");
	canvas.width = request.width ?? 960;
	canvas.height = Math.max(1, Math.round(canvas.width * image.height / image.width));
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas unavailable");
	context.drawImage(image, 0, 0, canvas.width, canvas.height);
	image.close();
	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
	if (!blob) throw new Error("Failed to create JPEG");
	const form = new FormData();
	form.set("rev", request.rev); form.set("time", String(time)); form.set("image", blob);
	if (variant) form.set("variant", variant);
	const response = await fetch("/api/agent/frame", { method: "POST", body: form });
	if (!response.ok) throw new Error(await response.text());
	return (await response.json()).file;
}
