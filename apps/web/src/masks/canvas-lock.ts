import type { Mask, RectangleMaskParams } from "./types";
import { isRectangleMaskParams } from "./geometry";

/**
 * Where an element is drawn on the canvas: its centre from the canvas's top left, its size (negative
 * when flipped) and its rotation in degrees, in the same units as the canvas size.
 */
export interface ElementFrame {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
	flipX?: boolean;
	flipY?: boolean;
}

type Canvas = { width: number; height: number };

/**
 * A box mask (rectangle, ellipse and the other box-like shapes) can be locked to the canvas: its
 * centre and size are then fractions of the canvas instead of the element, so the window stays where
 * it is while the element moves or zooms behind it (a facecam window that follows a face).
 */
export function isCanvasLocked(mask: Mask | undefined): mask is Mask & { params: RectangleMaskParams } {
	return !!mask && mask.params.canvasLocked === true && isRectangleMaskParams(mask.params as RectangleMaskParams);
}

function axes(frame: ElementFrame) {
	const width = Math.abs(frame.width);
	const height = Math.abs(frame.height);
	const flipX = frame.flipX ?? frame.width < 0;
	const flipY = frame.flipY ?? frame.height < 0;
	const radians = (frame.rotation * Math.PI) / 180;
	return { width, height, flipX, flipY, cos: Math.cos(radians), sin: Math.sin(radians), mirrored: flipX !== flipY };
}

const normalizeDegrees = (degrees: number) => ((degrees % 360) + 360) % 360;

/**
 * The element-space mask that draws a canvas-locked mask on this frame, as the renderer, hit tests
 * and handles use it. A mask that is not canvas-locked comes back as it is.
 */
export function maskInElementSpace<T extends Mask>({ mask, frame, canvas }: { mask: T; frame: ElementFrame; canvas: Canvas }): T {
	if (!isCanvasLocked(mask)) return mask;
	const params = mask.params;
	const { width, height, flipX, flipY, cos, sin, mirrored } = axes(frame);
	if (width === 0 || height === 0) return mask;
	// The renderer draws the element as: move to its centre, rotate, flip. This undoes it.
	const x = canvas.width / 2 + params.centerX * canvas.width - frame.cx;
	const y = canvas.height / 2 + params.centerY * canvas.height - frame.cy;
	let localX = x * cos + y * sin;
	let localY = -x * sin + y * cos;
	if (flipX) localX = -localX;
	if (flipY) localY = -localY;
	const rotation = params.rotation - frame.rotation;
	return {
		...mask,
		params: {
			...params,
			centerX: localX / width,
			centerY: localY / height,
			width: (params.width * canvas.width) / width,
			height: (params.height * canvas.height) / height,
			rotation: normalizeDegrees(mirrored ? -rotation : rotation),
			canvasLocked: false,
		},
	};
}

/** The canvas-locked params of an element-space box mask shown on this frame (the inverse of maskInElementSpace). */
export function paramsLockedToCanvas({ params, frame, canvas }: { params: RectangleMaskParams; frame: ElementFrame; canvas: Canvas }): RectangleMaskParams {
	const { width, height, flipX, flipY, cos, sin, mirrored } = axes(frame);
	let localX = params.centerX * width;
	let localY = params.centerY * height;
	if (flipX) localX = -localX;
	if (flipY) localY = -localY;
	const x = localX * cos - localY * sin;
	const y = localX * sin + localY * cos;
	return {
		...params,
		centerX: (frame.cx + x - canvas.width / 2) / canvas.width,
		centerY: (frame.cy + y - canvas.height / 2) / canvas.height,
		width: (params.width * width) / canvas.width,
		height: (params.height * height) / canvas.height,
		rotation: normalizeDegrees((mirrored ? -params.rotation : params.rotation) + frame.rotation),
		canvasLocked: true,
	};
}
