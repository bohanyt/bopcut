import { upsertAgentKeyframe } from "@/agent/compound-content";
import { TracksSnapshotCommand } from "@/commands/timeline";
import type { EditorCore } from "@/core";
import { isCanvasLocked } from "@/masks/canvas-lock";
import { getVisibleElementsWithBounds } from "@/preview/element-bounds";
import { clampRetimeRate } from "@/retime/rate";
import type { ElementRef, SceneTracks, TimelineTrack, VideoElement } from "@/timeline/types";
import { TICKS_PER_SECOND } from "@/wasm";
import { planFaceFollow, sourceInWindow, type CanvasWindow, type FollowSample } from "./face-follow";
import { patchDetail, trackPoint, type GrayFrame } from "./point-track";
import { readGrayFrames } from "./read-frames";
import { framePart, type SourceRect } from "./split-layout";

/** Samples a second: enough to follow a face, few enough to read a long clip quickly. */
const FOLLOW_FPS = 10;
const TRANSFORM_KEYS = ["transform.positionX", "transform.positionY", "transform.scaleX", "transform.scaleY", "transform.rotate"];

export type FollowFailure = "not-a-window" | "no-media" | "outside" | "no-detail" | "gone";

/** Less grey-value spread than this around the click is too flat to follow. */
const MIN_DETAIL = 3;

/** Whether a clip can follow a face: a video behind a canvas-locked window (a split layout's facecam). */
export function canFollowFace(element: { type: string; masks?: unknown[] } | undefined): element is VideoElement {
	return element?.type === "video" && isCanvasLocked((element as VideoElement).masks?.[0]);
}

/**
 * Follows the face under `point` (canvas pixels, at the playhead) through the whole clip and writes
 * the clip's zoom and position keyframes, so the face stays at the centre of its window, in one Undo
 * step. The facecam's part of the picture bounds the window, so it never shows the game around it.
 */
export async function followFace(editor: EditorCore, { clip, point, signal, onProgress, readFrames = readGrayFrames }: {
	clip: ElementRef;
	point: { x: number; y: number };
	signal?: AbortSignal;
	onProgress?: (done: number, total: number) => void;
	readFrames?: (request: { file: Blob; crop: SourceRect; times: number[]; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }) => Promise<GrayFrame[]>;
}): Promise<{ ok: true; keys: number; zoom: number; lostShare: number } | { ok: false; reason: FollowFailure }> {
	const canvas = editor.project.getActive().settings.canvasSize;
	const found = editor.timeline.getElementsWithTracks({ elements: [clip] })[0]?.element;
	if (!canFollowFace(found)) return { ok: false, reason: "not-a-window" };
	const element = found;
	const asset = editor.media.getAssets().find(({ id }) => id === element.mediaId);
	if (!asset?.file || !asset.width || !asset.height) return { ok: false, reason: "no-media" };

	const mask = element.masks![0].params as { centerX: number; centerY: number; width: number; height: number };
	const window: CanvasWindow = {
		cx: canvas.width / 2 + mask.centerX * canvas.width, cy: canvas.height / 2 + mask.centerY * canvas.height,
		width: mask.width * canvas.width, height: mask.height * canvas.height,
	};
	const media = { width: asset.width, height: asset.height };
	const fit = Math.min(canvas.width / media.width, canvas.height / media.height);
	const shown = { width: media.width * fit, height: media.height * fit };
	const param = (key: string, fallback: number) => (typeof element.params[key] === "number" ? (element.params[key] as number) : fallback);
	const allowed = element.reframe?.facecam ?? sourceInWindow({
		frame: { shown, scale: param("transform.scaleX", 1), positionX: param("transform.positionX", 0), positionY: param("transform.positionY", 0) },
		window, canvas,
	});
	const base = { shown, ...framePart({ part: allowed, window: { top: window.cy - window.height / 2, height: window.height }, media, canvas }) };

	// The clicked point, through the clip as it is drawn at the playhead (keyframes included).
	const time = editor.playback.getCurrentTime();
	const [entry] = getVisibleElementsWithBounds({
		tracks: editor.scenes.getActiveScene().tracks, currentTime: time, canvasSize: canvas,
		mediaAssets: editor.media.getAssets(), onlyElements: [clip],
	});
	if (!entry) return { ok: false, reason: "outside" };
	const { bounds } = entry;
	const seed = {
		x: (point.x - (bounds.cx - Math.abs(bounds.width) / 2)) / Math.abs(bounds.width),
		y: (point.y - (bounds.cy - Math.abs(bounds.height) / 2)) / Math.abs(bounds.height),
	};
	if (seed.x < allowed.x || seed.x > allowed.x + allowed.width || seed.y < allowed.y || seed.y > allowed.y + allowed.height) {
		return { ok: false, reason: "outside" };
	}

	const duration = element.duration / TICKS_PER_SECOND;
	const rate = clampRetimeRate({ rate: element.retime?.rate ?? 1 });
	const trim = element.trimStart / TICKS_PER_SECOND;
	const localTimes = Array.from({ length: Math.floor(duration * FOLLOW_FPS) + 1 }, (_, index) => Math.min(duration, index / FOLLOW_FPS));
	const frames = await readFrames({ file: asset.file, crop: allowed, times: localTimes.map((local) => trim + local * rate), signal, onProgress });
	if (!frames.length) return { ok: false, reason: "no-media" };
	const { width: frameWidth, height: frameHeight } = frames[0];
	const seedLocal = (time - element.startTime) / TICKS_PER_SECOND;
	const seedIndex = Math.max(0, Math.min(frames.length - 1, Math.round(seedLocal * FOLLOW_FPS)));
	const start = { index: seedIndex, x: ((seed.x - allowed.x) / allowed.width) * frameWidth, y: ((seed.y - allowed.y) / allowed.height) * frameHeight };
	const patch = Math.max(4, Math.round(frameWidth * 0.03));
	if (patchDetail({ frame: frames[seedIndex], x: start.x, y: start.y, half: patch }) < MIN_DETAIL) return { ok: false, reason: "no-detail" };
	const track = trackPoint({ frames, seed: start, options: { patch, search: Math.max(8, Math.round(frameWidth * 0.06)) } });
	const samples: FollowSample[] = track.map((sample, index) => ({
		time: localTimes[index] ?? sample.time,
		x: allowed.x + (sample.x / frameWidth) * allowed.width,
		y: allowed.y + (sample.y / frameHeight) * allowed.height,
		lost: sample.lost,
	}));
	const plan = planFaceFollow({ samples, base, allowed, window, canvas });

	// The timeline may have changed while the frames were read: the clip is replaced as it is now.
	const scene = editor.scenes.getActiveScene();
	const current = editor.timeline.getElementsWithTracks({ elements: [clip] })[0]?.element;
	if (!canFollowFace(current)) return { ok: false, reason: "gone" };
	const kept = Object.fromEntries(Object.entries(current.animations ?? {}).filter(([path]) => !TRANSFORM_KEYS.includes(path)));
	let followed: VideoElement = {
		...current,
		params: { ...current.params, "transform.scaleX": plan.scale, "transform.scaleY": plan.scale, "transform.rotate": 0 },
		animations: Object.keys(kept).length ? (kept as VideoElement["animations"]) : undefined,
	};
	for (const key of plan.keys) {
		followed = upsertAgentKeyframe(followed, { propertyPath: "transform.positionX", time: key.time, value: key.positionX });
		followed = upsertAgentKeyframe(followed, { propertyPath: "transform.positionY", time: key.time, value: key.positionY });
	}
	const replace = <T extends TimelineTrack>(candidate: T): T =>
		({ ...candidate, elements: candidate.elements.map((item) => (item.id === element.id ? followed : item)) }) as T;
	const after: SceneTracks = { overlay: scene.tracks.overlay.map(replace), main: replace(scene.tracks.main), audio: scene.tracks.audio.map(replace) };
	editor.command.execute({ command: new TracksSnapshotCommand({ before: scene.tracks, after, ripples: false }) });
	return { ok: true, keys: plan.keys.length, zoom: plan.zoom, lostShare: samples.filter(({ lost }) => lost).length / samples.length };
}
