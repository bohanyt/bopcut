import { simplifyTrack, smoothTrack } from "./point-track";
import type { SourceRect } from "./split-layout";

/** A clip's frame: the source fitted in the canvas (`shown`, before scale), then scaled and moved. */
export interface ClipFrame {
	shown: { width: number; height: number };
	scale: number;
	positionX: number;
	positionY: number;
}

/** A window on the canvas: its centre and size in canvas pixels. */
export interface CanvasWindow {
	cx: number;
	cy: number;
	width: number;
	height: number;
}

/** How much a face follow zooms in at least, so the window has room to move inside the facecam. */
export const FOLLOW_ZOOM = 1.15;
/** How much it zooms in at most: more would show the facecam's pixels too large. */
export const MAX_FOLLOW_ZOOM = 1.6;

/** The part of the source a window shows for a clip frame (no rotation), in fractions of the picture. */
export function sourceInWindow({ frame, window, canvas }: { frame: ClipFrame; window: CanvasWindow; canvas: { width: number; height: number } }): SourceRect {
	const width = frame.shown.width * frame.scale, height = frame.shown.height * frame.scale;
	const left = canvas.width / 2 + frame.positionX - width / 2;
	const top = canvas.height / 2 + frame.positionY - height / 2;
	return {
		x: (window.cx - window.width / 2 - left) / width,
		y: (window.cy - window.height / 2 - top) / height,
		width: window.width / width,
		height: window.height / height,
	};
}

/** A canvas point as a point of the source picture, for a clip frame (no rotation). */
export function sourcePoint({ point, frame, canvas }: { point: { x: number; y: number }; frame: ClipFrame; canvas: { width: number; height: number } }) {
	const width = frame.shown.width * frame.scale, height = frame.shown.height * frame.scale;
	return {
		x: (point.x - (canvas.width / 2 + frame.positionX - width / 2)) / width,
		y: (point.y - (canvas.height / 2 + frame.positionY - height / 2)) / height,
	};
}

/**
 * The position that puts a point of the source at the window's centre, at `scale`, without letting
 * the window show anything outside `allowed` (the facecam): near an edge the point moves off centre
 * instead.
 */
export function followPosition({ point, scale, shown, window, allowed, canvas }: {
	point: { x: number; y: number };
	scale: number;
	shown: { width: number; height: number };
	window: CanvasWindow;
	allowed: SourceRect;
	canvas: { width: number; height: number };
}): { positionX: number; positionY: number } {
	const width = shown.width * scale, height = shown.height * scale;
	const halfX = window.width / 2 / width, halfY = window.height / 2 / height;
	const keep = (value: number, from: number, size: number, half: number) =>
		size <= 2 * half ? from + size / 2 : Math.min(from + size - half, Math.max(from + half, value));
	const x = keep(point.x, allowed.x, allowed.width, halfX);
	const y = keep(point.y, allowed.y, allowed.height, halfY);
	return {
		positionX: window.cx - canvas.width / 2 - (x - 0.5) * width,
		positionY: window.cy - canvas.height / 2 - (y - 0.5) * height,
	};
}

/** A followed point at a time of the clip (seconds from its start), in fractions of the source picture. */
export interface FollowSample {
	time: number;
	x: number;
	y: number;
	lost: boolean;
}

/**
 * The scale and position keyframes that keep a followed point at the window's centre: the track is
 * smoothed (±`smoothing` samples), turned into positions that never show more than `allowed`, and cut
 * to the few keyframes that stay within `tolerance` canvas pixels of them.
 */
export function planFaceFollow({ samples, base, allowed, window, canvas, zoom, smoothing = 2, tolerance = 3 }: {
	samples: FollowSample[];
	/** The clip's frame that shows `allowed` through the window (as the split layout leaves it). */
	base: ClipFrame;
	allowed: SourceRect;
	window: CanvasWindow;
	canvas: { width: number; height: number };
	/** A fixed zoom; by default the least zoom (from FOLLOW_ZOOM to MAX_FOLLOW_ZOOM) that keeps the point centred. */
	zoom?: number;
	smoothing?: number;
	tolerance?: number;
}): { scale: number; zoom: number; keys: { time: number; positionX: number; positionY: number }[] } {
	const smoothed = smoothTrack(samples.map((sample) => ({ ...sample, score: 1 })), smoothing);
	const used = zoom ?? zoomToCentre({ points: smoothed.filter(({ lost }) => !lost), base, allowed, window });
	const scale = base.scale * used;
	const positions = smoothed.map((sample) => {
		const { positionX, positionY } = followPosition({ point: sample, scale, shown: base.shown, window, allowed, canvas });
		return { time: sample.time, x: positionX, y: positionY, score: 1, lost: false };
	});
	return { scale, zoom: used, keys: simplifyTrack(positions, tolerance).map(({ time, x, y }) => ({ time, positionX: x, positionY: y })) };
}

/**
 * The least zoom that keeps the followed point at the window's centre for nearly all of the clip
 * (95 % of the samples, so one stray match does not zoom everything in): a zoomed-in window is smaller
 * in the picture, so it can follow the point closer to the facecam's edge before it must stop.
 * Bounded by FOLLOW_ZOOM and MAX_FOLLOW_ZOOM.
 */
export function zoomToCentre({ points, base, allowed, window }: {
	points: { x: number; y: number }[];
	base: ClipFrame;
	allowed: SourceRect;
	window: CanvasWindow;
}): number {
	if (!points.length) return FOLLOW_ZOOM;
	// Half the window, in fractions of the picture, before any zoom.
	const halfX = window.width / 2 / (base.shown.width * base.scale);
	const halfY = window.height / 2 / (base.shown.height * base.scale);
	const needed = points.map(({ x, y }) => {
		const roomX = Math.min(x - allowed.x, allowed.x + allowed.width - x);
		const roomY = Math.min(y - allowed.y, allowed.y + allowed.height - y);
		return roomX <= 0 || roomY <= 0 ? Infinity : Math.max(halfX / roomX, halfY / roomY);
	}).sort((a, b) => a - b);
	const nearlyAll = needed[Math.min(needed.length - 1, Math.ceil(needed.length * 0.95) - 1)];
	return Math.min(MAX_FOLLOW_ZOOM, Math.max(FOLLOW_ZOOM, nearlyAll));
}
