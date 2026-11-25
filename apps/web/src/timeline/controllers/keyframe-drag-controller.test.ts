import { afterEach, expect, test } from "bun:test";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { FrameRate } from "opencut-wasm";
import type { VideoElement } from "@/timeline";
import type { SelectedKeyframeRef } from "@/animation/types";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import { isTimelineGestureActive } from "@/timeline/gesture-state";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { addMediaTime, mediaTime, roundFrameTicks, roundFrameTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import { KeyframeDragController, type KeyframeDragConfig } from "./keyframe-drag-controller";

const DRAG = TIMELINE_DRAG_THRESHOLD_PX + 2;
const PPS = BASE_TIMELINE_PIXELS_PER_SECOND;
const START = 400;
const PARAMS = {
	"transform.positionX": 0, "transform.positionY": 0, "transform.scaleX": 1, "transform.scaleY": 1,
	"transform.rotate": 0, opacity: 1,
};
const NTSC = { numerator: 30_000, denominator: 1_001 };
const FILM = { numerator: 24_000, denominator: 1_001 };
const D = [17, 31, 53, 89, 127, 211, 333, 401, 503, 607, 733, 811, 919, 1003, 1111, 1203, 1309, 1417, 1501, 1619];

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

const keyRef = (id: string): SelectedKeyframeRef => ({ trackId: "main", elementId: "c", propertyPath: "opacity", keyframeId: id });
const clip = (start: number, keyTicks: number[], duration = 600_000): VideoElement => ({
	id: "c", type: "video", name: "c", mediaId: "m",
	startTime: mediaTime({ ticks: start }), duration: mediaTime({ ticks: duration }),
	trimStart: ZERO_MEDIA_TIME, trimEnd: ZERO_MEDIA_TIME, params: PARAMS,
	animations: { opacity: { keys: keyTicks.map((time, i) => ({ id: `k${i}`, time: mediaTime({ ticks: time }), value: 1, segmentToNext: "linear", tangentMode: "flat" })) } },
});

function harness(element: VideoElement, fps: FrameRate, selected = [keyRef("k0")], grabbed = selected) {
	const view = new EventTarget();
	const page = Object.assign(new EventTarget(), { activeElement: null, defaultView: view });
	const commits: unknown[] = [];
	let cancelPrevious: (() => void) | undefined;
	const prev = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: page });
	const cfg: KeyframeDragConfig = {
		zoomLevel: 1, getFps: () => fps, element, displayedStartTime: element.startTime, selectedKeyframes: selected,
		isKeyframeSelected: () => true, setKeyframeSelection: () => {}, toggleKeyframeSelection: () => {},
		selectKeyframeRange: () => {}, executeCommand: (command) => { commits.push(command); },
		beginPreviewGesture: (cancel) => {
			cancelPrevious?.();
			cancelPrevious = cancel;
			return { finish: () => { cancelPrevious = undefined; }, cancel };
		},
		seek: () => {}, getTotalDuration: () => mediaTime({ ticks: 1_000_000 }),
	};
	const c = new KeyframeDragController({ configRef: { current: cfg } });
	const before = cleanup;
	cleanup = () => {
		c.destroy();
		if (prev) Object.defineProperty(globalThis, "document", prev);
		else Reflect.deleteProperty(globalThis, "document");
		before?.();
	};
	const down = (button = 0) => c.onKeyframeMouseDown({
		event: { button, clientX: START, clientY: 0, metaKey: false, ctrlKey: false, shiftKey: false,
			preventDefault: () => {}, stopPropagation: () => {}, currentTarget: { ownerDocument: page } } as unknown as ReactMouseEvent,
		keyframes: grabbed,
	});
	const move = (x: number) => page.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: x }));
	const up = (button = 0) => page.dispatchEvent(Object.assign(new Event("mouseup"), { button }));
	const drag = (x: number) => { down(); move(START + DRAG); move(x); return c.keyframeDragState.deltaTicks; };
	const xFor = (ticks: number) => START + (ticks / TICKS_PER_SECOND) * PPS;
	return { drag, move, down, up, view, commits, xFor, state: () => c.keyframeDragState, raw: (x: number) => Math.round(((x - START) / PPS) * TICKS_PER_SECOND) };
}

test("grabbed key anchors frame snapping when it is not the first selected key", () => {
	const fps = NTSC;
	const offFrame = 55_555;
	const onFrame = roundFrameTime({ time: mediaTime({ ticks: 30_000 }), fps });
	expect(roundFrameTime({ time: mediaTime({ ticks: offFrame }), fps })).not.toBe(mediaTime({ ticks: offFrame }));
	const sel = [keyRef("k0"), keyRef("k1")];
	const element = clip(0, [offFrame, onFrame]);
	const anchor = addMediaTime({ a: element.startTime, b: onFrame });
	const h = harness(element, fps, sel, [keyRef("k1")]);
	for (const raw of D) {
		const landed = addMediaTime({ a: anchor, b: mediaTime({ ticks: h.drag(h.xFor(raw)) }) });
		expect(landed).toBe(roundFrameTime({ time: landed, fps }));
	}
});

test("fractional fps: anchor timeline time stays on frame grid for many drags", () => {
	for (const fps of [NTSC, FILM]) {
		const rel = roundFrameTime({ time: mediaTime({ ticks: 55_555 }), fps });
		const element = clip(12_345, [rel]);
		const anchor = addMediaTime({ a: element.startTime, b: rel });
		const h = harness(element, fps);
		for (const raw of D) {
			const landed = addMediaTime({ a: anchor, b: mediaTime({ ticks: h.drag(h.xFor(raw)) }) });
			expect(landed).toBe(roundFrameTime({ time: landed, fps }));
		}
	}
});

test("30 fps on-frame keys match roundFrameTicks delta snapping", () => {
	const fps = { numerator: 30, denominator: 1 };
	const step = TICKS_PER_SECOND / 30;
	const h = harness(clip(step * 4, [step * 10]), fps);
	for (const raw of D) {
		const x = h.xFor(raw);
		expect(h.drag(x)).toBe(roundFrameTicks({ ticks: h.raw(x), fps }));
	}
});

test("two keyframes keep their spacing while dragging", () => {
	const t0 = roundFrameTime({ time: mediaTime({ ticks: 20_000 }), fps: NTSC });
	const t1 = roundFrameTime({ time: mediaTime({ ticks: 80_000 }), fps: NTSC });
	const sel = [keyRef("k0"), keyRef("k1")];
	const h = harness(clip(0, [t0, t1]), NTSC, sel);
	h.down(); h.move(START + DRAG); h.move(START + 90);
	const d = h.state().deltaTicks;
	expect(addMediaTime({ a: t1, b: mediaTime({ ticks: d }) }) - addMediaTime({ a: t0, b: mediaTime({ ticks: d }) })).toBe(t1 - t0);
});

test("counts as a gesture from the first move to the release", () => {
	const h = harness(clip(0, [30_000]), { numerator: 30, denominator: 1 });
	h.down();
	expect(isTimelineGestureActive()).toBe(false);
	h.move(START + DRAG);
	expect(isTimelineGestureActive()).toBe(true);
	h.up();
	expect(isTimelineGestureActive()).toBe(false);
});

test("middle-button press does not start a keyframe drag", () => {
	const h = harness(clip(0, [30_000]), { numerator: 30, denominator: 1 });
	h.down(1);
	h.move(START + DRAG);
	expect(isTimelineGestureActive()).toBe(false);
	h.up(1);
	expect(h.commits).toHaveLength(0);
});

test("secondary release leaves keyframe drag active and window blur cancels it", () => {
	const h = harness(clip(0, [30_000]), { numerator: 30, denominator: 1 });
	h.down();
	h.move(START + DRAG);
	h.up(2);
	expect(isTimelineGestureActive()).toBe(true);
	expect(h.commits).toHaveLength(0);
	h.view.dispatchEvent(new Event("blur"));
	expect(isTimelineGestureActive()).toBe(false);
	h.up();
	expect(h.commits).toHaveLength(0);
});

test("clamps at both clip ends", () => {
	const fps = { numerator: 30, denominator: 1 };
	const dur = 100_000;
	const h = harness(clip(0, [95_000], dur), fps);
	expect(h.drag(h.xFor(500_000))).toBe(dur - 95_000);
	expect(harness(clip(0, [3_000], dur), fps).drag(h.xFor(-500_000))).toBe(-3_000);
});

test("drag back to start yields zero delta", () => {
	const fps = NTSC;
	const h = harness(clip(roundFrameTime({ time: mediaTime({ ticks: 1_000 }), fps }), [roundFrameTime({ time: mediaTime({ ticks: 40_000 }), fps })]), fps);
	h.down(); h.move(START + DRAG); h.move(START + 120);
	expect(h.state().deltaTicks).not.toBe(0);
	h.move(START);
	expect(h.state().deltaTicks).toBe(0);
});
