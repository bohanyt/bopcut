import { afterEach, expect, test } from "bun:test";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Bookmark, SceneTracks } from "@/timeline";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import { PlayheadController } from "./playhead-controller";

const time = (seconds: number) => mediaTimeFromSeconds({ seconds });
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup({ autoScroll = false, isPlaying = false } = {}) {
	const events = new EventTarget();
	const frames = new Map<number, FrameRequestCallback>();
	let id = 0;
	const replacements = {
		window: events,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++id, callback);
			return id;
		},
		cancelAnimationFrame: (frame: number) => { frames.delete(frame); },
	};
	const descriptors = Object.keys(replacements).map((key) =>
		[key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const [key, value] of Object.entries(replacements)) {
		Object.defineProperty(globalThis, key, { value, configurable: true });
	}
	const seek: MediaTime[] = [];
	const drawnAtSeek: Array<string | undefined> = [];
	const saved: MediaTime[] = [];
	const scrubbing: boolean[] = [];
	const ruler = { getBoundingClientRect: () => ({ left: 0 }) } as HTMLDivElement;
	const rulerViewport = {
		scrollLeft: 0, clientWidth: 200, scrollWidth: 500,
		getBoundingClientRect: () => ({ left: 0 }),
	} as HTMLDivElement;
	const tracksViewport = { scrollLeft: 0 } as HTMLDivElement;
	const attrs = new Map<string, string>();
	const playhead = {
		style: { left: "" },
		contains: () => false,
		getAttribute: (name: string) => attrs.get(name),
		setAttribute: (name: string, value: string) => attrs.set(name, value),
	} as unknown as HTMLDivElement;
	let edgeReads = 0;
	const tracks: SceneTracks = {
		main: {
			id: "main", name: "Main", type: "video", muted: false, hidden: false,
			get elements() {
				edgeReads++;
				return [];
			},
		},
		audio: [],
		overlay: [],
	};
	let bookmarks: Bookmark[] = [{ time: time(1) }];
	let shift = false;
	const controller = new PlayheadController({
		configRef: { current: {
			zoomLevel: 1,
			duration: time(10),
			getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
			isShiftHeld: () => shift,
			getIsPlaying: () => isPlaying,
			getRulerEl: () => ruler,
			getRulerScrollEl: () => autoScroll ? rulerViewport : null,
			getTracksScrollEl: () => autoScroll ? tracksViewport : null,
			getPlayheadEl: () => playhead,
			getSceneTracks: () => tracks,
			getSceneBookmarks: () => bookmarks,
			seek: (value) => {
				seek.push(value);
				drawnAtSeek.push(attrs.get("aria-valuenow"));
			},
			setScrubbing: (value) => scrubbing.push(value),
			setTimelineViewState: ({ playheadTime }) => saved.push(playheadTime),
		} },
	});
	cleanup = () => {
		controller.destroy();
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	const event = (clientX: number) => ({ clientX, button: 0, preventDefault() {}, stopPropagation() {} }) as ReactMouseEvent;
	const send = (type: string, clientX: number) => {
		events.dispatchEvent(Object.assign(new Event(type), { clientX }));
	};
	return {
		controller, event, seek, saved, scrubbing, drawnAtSeek, rulerViewport, tracksViewport,
		move: (x: number) => send("mousemove", x),
		release: (x: number) => send("mouseup", x),
		frame() { for (const [frame, callback] of [...frames]) { frames.delete(frame); callback(0); } },
		edgeReads: () => edgeReads,
		setBookmarks: (value: Bookmark[]) => { bookmarks = value; },
		holdShift: () => { shift = true; },
	};
}

test("scrub seeks once per frame and flushes the last position before saving", () => {
	const scrub = setup();
	scrub.controller.onRulerMouseDown(scrub.event(0));
	scrub.move(70);
	scrub.move(100);
	expect(scrub.seek).toEqual([time(0)]);
	scrub.frame();
	expect(scrub.seek).toEqual([time(0), time(2)]);
	scrub.move(150);
	scrub.release(150);
	scrub.frame();
	expect(scrub.seek).toEqual([time(0), time(2), time(3)]);
	expect(scrub.drawnAtSeek).toEqual(scrub.seek.map(String));
	expect(scrub.saved).toEqual([time(3)]);
	expect(scrub.scrubbing).toEqual([true, false]);
});

test("snap points are reused until the scene data changes and Shift bypasses the cache", () => {
	const scrub = setup();
	scrub.controller.onRulerMouseDown(scrub.event(47));
	expect(scrub.seek[0]).not.toBe(time(1));
	scrub.move(47);
	scrub.frame();
	expect(scrub.seek.at(-1)).toBe(time(1));
	const reads = scrub.edgeReads();
	scrub.move(48);
	scrub.frame();
	expect(scrub.edgeReads()).toBe(reads);
	scrub.setBookmarks([{ time: time(0.9) }]);
	scrub.move(47);
	scrub.frame();
	expect(scrub.edgeReads()).toBeGreaterThan(reads);
	expect(scrub.seek.at(-1)).toBe(time(0.9));
	scrub.holdShift();
	scrub.move(47);
	scrub.release(47);
	expect(scrub.seek.at(-1)).toBe(scrub.seek[0]!);
});

test("the scrub session scrolls both viewports at an edge and stops on release", () => {
	const scrub = setup({ autoScroll: true });
	scrub.controller.onRulerMouseDown(scrub.event(100));
	scrub.move(190);
	scrub.frame();
	const scrollLeft = scrub.rulerViewport.scrollLeft;
	expect(scrollLeft).toBeGreaterThan(0);
	expect(scrub.tracksViewport.scrollLeft).toBe(scrollLeft);
	scrub.release(190);
	scrub.frame();
	expect(scrub.rulerViewport.scrollLeft).toBe(scrollLeft);
});

test("scrubbing while playing can seek back to the same snapped frame", () => {
	const scrub = setup({ isPlaying: true });
	scrub.controller.onRulerMouseDown(scrub.event(50));
	scrub.move(51);
	scrub.frame();
	expect(scrub.seek).toEqual([time(1), time(1)]);
});
