import { expect, test } from "bun:test";
import { maskInElementSpace, paramsLockedToCanvas, type ElementFrame } from "../canvas-lock";
import type { RectangleMask, RectangleMaskParams } from "../types";

const canvas = { width: 1080, height: 1920 };
const base: RectangleMaskParams = {
	feather: 0, inverted: false, strokeColor: "#fff", strokeWidth: 0, strokeAlign: "center",
	centerX: 0.1, centerY: 0.25, width: 0.9, height: 0.4, rotation: 10, scale: 1, canvasLocked: true,
};
const mask = (params: RectangleMaskParams): RectangleMask => ({ id: "m", type: "rectangle", params });

/** A point of the element's own drawing (from its centre) on the canvas, drawn as the renderer does: centre, rotate, flip. */
function onCanvas(frame: ElementFrame, x: number, y: number) {
	const flipX = frame.width < 0 ? -1 : 1, flipY = frame.height < 0 ? -1 : 1;
	const r = (frame.rotation * Math.PI) / 180;
	const fx = x * flipX, fy = y * flipY;
	return { x: frame.cx + fx * Math.cos(r) - fy * Math.sin(r), y: frame.cy + fx * Math.sin(r) + fy * Math.cos(r) };
}
/** The box's corners on the canvas, from params in a space of this width and height whose centre sits at `at`. */
function corners(params: RectangleMaskParams, size: { width: number; height: number }, place: (x: number, y: number) => { x: number; y: number }) {
	const r = (params.rotation * Math.PI) / 180;
	const cx = params.centerX * size.width, cy = params.centerY * size.height;
	const hw = (params.width * size.width) / 2, hh = (params.height * size.height) / 2;
	return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
		const dx = sx * hw, dy = sy * hh;
		return place(cx + dx * Math.cos(r) - dy * Math.sin(r), cy + dx * Math.sin(r) + dy * Math.cos(r));
	});
}

const frames: ElementFrame[] = [
	{ cx: 540, cy: 1400, width: 1920 * 1.4, height: 1080 * 1.4, rotation: 0 },
	{ cx: 300, cy: 900, width: 800, height: 450, rotation: 30 },
	{ cx: 700, cy: 1200, width: -1000, height: 562, rotation: 0 },
	{ cx: 520, cy: 1000, width: -640, height: -360, rotation: 300 },
	{ cx: 610, cy: 1650, width: 900, height: -500, rotation: 77 },
];

test.each(frames)("a canvas-locked box draws the same canvas box on the element $width x $height at $rotation°", (frame) => {
	const local = maskInElementSpace({ mask: mask(base), frame, canvas }).params;
	expect(local.canvasLocked).toBe(false);
	const expected = corners(base, canvas, (x, y) => ({ x: canvas.width / 2 + x, y: canvas.height / 2 + y }));
	const drawn = corners(local, { width: Math.abs(frame.width), height: Math.abs(frame.height) }, (x, y) => onCanvas(frame, x, y));
	// The same four points, possibly listed from another corner when the element is mirrored.
	const sorted = (points: { x: number; y: number }[]) => points.map(({ x, y }) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	expect(sorted(drawn)).toEqual(sorted(expected));
	// And back.
	const back = paramsLockedToCanvas({ params: local, frame, canvas });
	for (const key of ["centerX", "centerY", "width", "height", "rotation"] as const) expect(back[key]).toBeCloseTo(base[key], 9);
	expect(back.canvasLocked).toBe(true);
});

test("a mask that is not locked, or not a box, is drawn as it is", () => {
	const unlocked = mask({ ...base, canvasLocked: false });
	expect(maskInElementSpace({ mask: unlocked, frame: frames[1], canvas })).toBe(unlocked);
	const split = { id: "s", type: "split", params: { feather: 0, inverted: false, strokeColor: "#fff", strokeWidth: 0, strokeAlign: "center", centerX: 0, centerY: 0, rotation: 0, canvasLocked: true } } as const;
	expect(maskInElementSpace({ mask: split as never, frame: frames[1], canvas })).toBe(split as never);
});
