import { EditorCore } from "@/core";
import { calculateTotalDuration } from "@/timeline";
import { lastFrameMediaTime, mediaTimeFromSeconds } from "@/wasm";
import { getRootScene } from "./scene-graph";
import { parseStateRef, resolveState, type TimelineState } from "./history";

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
		if (localStorage.getItem(key) === request.rev) return;
		const states = framesStates(request, project.metadata.id);
		if (typeof states === "string") {
			// Refused once per rev, with the reason.
			const response = await fetch("/api/agent/frames-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rev: request.rev, files: [], error: states, projectId: project.metadata.id }) });
			if (response.ok) localStorage.setItem(key, request.rev);
			return;
		}
		const files: string[] = [];
		const compared: string[] = [];
		for (const time of request.times as number[]) {
			for (const [state, variant] of [[states.state, undefined], ...(states.compare ? [[states.compare, "compare"]] : [])] as [TimelineState | null, string | undefined][]) {
				if (editor.timeline.isPreviewActive() || editor.project.getActiveOrNull()?.metadata.id !== project.metadata.id) return;
				const file = await renderFrame({ request, time, state, variant });
				(variant ? compared : files).push(file);
			}
		}
		const response = await fetch("/api/agent/frames-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rev: request.rev, files, ...(states.compare ? { compare: compared } : {}), projectId: project.metadata.id }) });
		if (!response.ok) throw new Error(await response.text());
		localStorage.setItem(key, request.rev);
	} catch (error) { console.error("Agent frame failed:", error); }
	finally { busy = false; }
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
	if (ticks > lastFrameMediaTime({ duration, fps: project.settings.fps })) throw new Error(`Time outside timeline: ${time}`);
	const snapshot = await editor.renderer.createSnapshot({ time: ticks, sceneId: root.id, ...(state ? { scenes } : {}) });
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
