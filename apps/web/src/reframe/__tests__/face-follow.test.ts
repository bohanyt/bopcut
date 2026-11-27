import { expect, test } from "bun:test";
import { followPosition, planFaceFollow, sourceInWindow, sourcePoint, zoomToCentre, type ClipFrame } from "../face-follow";
import { framePart } from "../split-layout";

const canvas = { width: 1080, height: 1920 };
const media = { width: 1920, height: 1080 };
const fit = Math.min(canvas.width / media.width, canvas.height / media.height);
const shown = { width: media.width * fit, height: media.height * fit };
const facecam = { x: 0.73, y: 0.65, width: 0.25, height: 0.33 };
const window = { cx: 540, cy: 1152 + 384, width: 1080, height: 768 };

/** The facecam copy as the split layout leaves it. */
const layoutFrame = (): ClipFrame => ({ shown, ...framePart({ part: facecam, window: { top: 1152, height: 768 }, media, canvas }) });

test("the window of a fresh split layout shows the facecam part, and a canvas point maps back into it", () => {
	const seen = sourceInWindow({ frame: layoutFrame(), window, canvas });
	// It shows the part cut to the window's shape: one side exactly, centred.
	expect(seen.x + seen.width / 2).toBeCloseTo(facecam.x + facecam.width / 2, 9);
	expect(seen.y + seen.height / 2).toBeCloseTo(facecam.y + facecam.height / 2, 9);
	expect(Math.max(seen.width - facecam.width, seen.height - facecam.height)).toBeCloseTo(0, 9);
	expect(Math.min(seen.width - facecam.width, seen.height - facecam.height)).toBeLessThanOrEqual(0);
	const centre = sourcePoint({ point: { x: window.cx, y: window.cy }, frame: layoutFrame(), canvas });
	expect(centre.x).toBeCloseTo(facecam.x + facecam.width / 2, 9);
	expect(centre.y).toBeCloseTo(facecam.y + facecam.height / 2, 9);
});

test("the followed point lands at the window's centre, and near an edge the window stays inside the facecam", () => {
	const frame = layoutFrame();
	const allowed = sourceInWindow({ frame, window, canvas });
	const scale = frame.scale * 1.3;
	const at = (point: { x: number; y: number }) => {
		const moved = { shown, scale, ...followPosition({ point, scale, shown, window, allowed, canvas }) };
		return { centre: sourcePoint({ point: { x: window.cx, y: window.cy }, frame: moved, canvas }), seen: sourceInWindow({ frame: moved, window, canvas }) };
	};
	const middle = { x: allowed.x + allowed.width / 2 + 0.01, y: allowed.y + allowed.height / 2 - 0.01 };
	expect(at(middle).centre.x).toBeCloseTo(middle.x, 9);
	expect(at(middle).centre.y).toBeCloseTo(middle.y, 9);
	// A point at the facecam's right edge: the window stops at the edge, the point is off centre.
	const edge = at({ x: allowed.x + allowed.width, y: middle.y });
	expect(edge.seen.x + edge.seen.width).toBeCloseTo(allowed.x + allowed.width, 9);
	expect(edge.seen.x).toBeGreaterThan(allowed.x);
	expect(edge.centre.y).toBeCloseTo(middle.y, 9);
});

test("a followed path becomes a zoomed-in clip with few position keys that keep the point centred", () => {
	const base = layoutFrame();
	const allowed = sourceInWindow({ frame: base, window, canvas });
	// A face drifting slowly to the right and back, sampled ten times a second for six seconds.
	const samples = Array.from({ length: 61 }, (_, index) => ({
		time: index / 10, lost: false,
		x: allowed.x + allowed.width * (0.5 + 0.08 * Math.sin(index / 12)), y: allowed.y + allowed.height * 0.45,
	}));
	const plan = planFaceFollow({ samples, base, allowed, window, canvas, zoom: 1.2, tolerance: 2 });
	expect(plan.scale).toBeCloseTo(base.scale * 1.2, 9);
	expect(plan.keys.length).toBeGreaterThan(2);
	expect(plan.keys.length).toBeLessThan(samples.length / 2);
	expect(plan.keys[0].time).toBe(0);
	expect(plan.keys.at(-1)!.time).toBeCloseTo(6, 9);
	// At a key, the (smoothed) point is at the window's centre, within a few pixels.
	for (const key of plan.keys) {
		const frame = { shown, scale: plan.scale, positionX: key.positionX, positionY: key.positionY };
		const centre = sourcePoint({ point: { x: window.cx, y: window.cy }, frame, canvas });
		const sample = samples[Math.round(key.time * 10)];
		expect(Math.abs((centre.x - sample.x) * shown.width * plan.scale)).toBeLessThan(6);
	}
});

test("the zoom rises just enough to keep a wide-moving point centred, up to a limit", () => {
	const base = layoutFrame();
	const allowed = sourceInWindow({ frame: base, window, canvas });
	const moving = (spread: number) => Array.from({ length: 81 }, (_, index) => ({
		time: index / 10, lost: false,
		x: allowed.x + allowed.width * (0.5 + spread * Math.sin(index / 13)), y: allowed.y + allowed.height * 0.5,
	}));
	// Barely moving: the least zoom.
	expect(zoomToCentre({ points: moving(0.01), base, allowed, window })).toBe(1.15);
	// Swinging an eighth of the facecam either way: about 1.3× (the window, half the facecam wide at 1×, needs that much room).
	const plan = planFaceFollow({ samples: moving(0.12), base, allowed, window, canvas, tolerance: 1 });
	expect(plan.zoom).toBeGreaterThan(1.15);
	expect(plan.zoom).toBeLessThan(1.6);
	for (const key of plan.keys) {
		const frame = { shown, scale: plan.scale, positionX: key.positionX, positionY: key.positionY };
		const seen = sourceInWindow({ frame, window, canvas });
		// Centred on the point (the window never had to stop) and inside the facecam.
		const centre = sourcePoint({ point: { x: window.cx, y: window.cy }, frame, canvas });
		expect(Math.abs((centre.x - (allowed.x + allowed.width * (0.5 + 0.12 * Math.sin(key.time * 10 / 13)))) * shown.width * plan.scale)).toBeLessThan(12);
		expect(seen.x).toBeGreaterThanOrEqual(allowed.x - 1e-9);
		expect(seen.x + seen.width).toBeLessThanOrEqual(allowed.x + allowed.width + 1e-9);
	}
	// To the very edge: the limit, and the window stops at the edge there.
	expect(zoomToCentre({ points: moving(0.5), base, allowed, window })).toBe(1.6);
	// A stray sample at the edge does not zoom everything in.
	const stray = [...moving(0.01), { time: 9, lost: false, x: allowed.x + allowed.width * 0.99, y: allowed.y + allowed.height * 0.5 }];
	expect(zoomToCentre({ points: stray, base, allowed, window })).toBe(1.15);
});
