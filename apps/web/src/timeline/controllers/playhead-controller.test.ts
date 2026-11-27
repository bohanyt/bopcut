import { afterEach, expect, test } from "bun:test";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Bookmark, SceneTracks } from "@/timeline";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import { PlayheadController } from "./playhead-controller";

const time = (seconds: number) => mediaTimeFromSeconds({ seconds });
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup({ autoScroll = false, isPlaying = false } = {}) {
	const events = new EventTarget();
	const page = Object.assign(new EventTarget(), { hidden: false });
	const captured = new Set<number>();
	const target = Object.assign(new EventTarget(), {
		setPointerCapture: (id: number) => captured.add(id),
		hasPointerCapture: (id: number) => captured.has(id),
		releasePointerCapture: (id: number) => captured.delete(id),
	});
	const frames = new Map<number, FrameRequestCallback>();
	let id = 0;
	const replacements = {
		window: events,
		document: page,
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
		style: { transform: "" },
		contains: () => false,
		getAttribute: (name: string) => attrs.get(name),
		setAttribute: (name: string, value: string) => attrs.set(name, value),
	} as unknown as HTMLDivElement;
	let edgeReads = 0;
	let currentTime = time(0);
	let sceneId = 'main';
	let projectSession = 1;
	let duration = time(10);
	let tracks: SceneTracks = {
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
	let snapping = true;
	let playing = isPlaying;
	let pauses = 0;
	const controller = new PlayheadController({
		configRef: { current: {
			zoomLevel: 1,
			getDuration: () => duration,
			getCurrentTime: () => currentTime,
			getSceneId: () => sceneId,
			getProjectSession: () => projectSession,
			getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
			isShiftHeld: () => shift,
			isSnappingEnabled: () => snapping,
			getIsPlaying: () => playing,
			getRulerEl: () => ruler,
			getRulerScrollEl: () => autoScroll ? rulerViewport : null,
			getTracksScrollEl: () => autoScroll ? tracksViewport : null,
			getPlayheadEl: () => playhead,
			getSceneTracks: () => tracks,
			getSceneBookmarks: () => bookmarks,
			seek: (value) => {
				currentTime = value;
				seek.push(value);
				drawnAtSeek.push(attrs.get("aria-valuenow"));
			},
			pause: () => {
				playing = false;
				pauses++;
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
	const event = (clientX: number) => ({ target, currentTarget: target, clientX, button: 0, buttons: 1, pointerId: 1, isPrimary: true, preventDefault() {}, stopPropagation() {} }) as unknown as ReactPointerEvent;
	const send = (type: string, clientX: number, { buttons = 1, pointerId = 1, receiver = events } = {}) => {
		receiver.dispatchEvent(Object.assign(new Event(type), { clientX, buttons, pointerId }));
	};
	return {
		controller, event, seek, saved, scrubbing, drawnAtSeek, rulerViewport, tracksViewport,
		move: (x: number, buttons = 1) => send("pointermove", x, { buttons }),
		release: (x: number) => send("pointerup", x, { buttons: 0 }),
		frame() { for (const [frame, callback] of [...frames]) { frames.delete(frame); callback(0); } },
		edgeReads: () => edgeReads,
		isPlaying: () => playing,
		pauses: () => pauses,
		play: () => { playing = true; },
		setBookmarks: (value: Bookmark[]) => { bookmarks = value; },
		holdShift: () => { shift = true; },
		turnSnappingOff: () => { snapping = false; },
		seekExternally: (value: MediaTime) => { currentTime = value; },
		setScene: (id: string) => { sceneId = id; controller.stopIfScopeChanged(); },
		setProjectSession: (id: number) => { projectSession = id; controller.stopIfScopeChanged(); },
		replaceTracks: () => { tracks = { ...tracks }; controller.stopIfScopeChanged(); },
		setDuration: (value: MediaTime) => { duration = value; },
		lineTime: () => attrs.get("aria-valuenow"),
		lineTransform: () => playhead.style.transform,
		pointerCaptured: () => captured.has(1),
		cancel: () => send("pointercancel", 400),
		loseCapture: () => send("lostpointercapture", 400, { receiver: target }),
		blur: () => events.dispatchEvent(new Event("blur")),
		pagehide: () => events.dispatchEvent(new Event("pagehide")),
		hide: () => { page.hidden = true; page.dispatchEvent(new Event("visibilitychange")); },
		moveOtherPointer: (x: number) => send("pointermove", x, { pointerId: 2 }),
	};
}

test("scrub seeks once per frame and flushes the last position before saving", () => {
	const scrub = setup();
	scrub.controller.onRulerPointerDown(scrub.event(0));
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

test("turning snapping off keeps the playhead on the pointer's frame", () => {
	const pixels = 52;
	const snapped = setup();
	snapped.controller.onRulerPointerDown(snapped.event(0));
	snapped.move(pixels);
	snapped.frame();
	expect(snapped.seek.at(-1)).toBe(time(1));
	cleanup?.();
	const free = setup();
	free.turnSnappingOff();
	free.controller.onRulerPointerDown(free.event(0));
	free.move(pixels);
	free.frame();
	expect(free.seek.at(-1)).not.toBe(time(1));
	expect(free.edgeReads()).toBe(0);
});

test("reveal scrolls only to a playhead outside the view", () => {
	const scrub = setup({ autoScroll: true });
	scrub.controller.reveal(time(1));
	expect(scrub.rulerViewport.scrollLeft).toBe(0);
	scrub.controller.reveal(time(8));
	expect(scrub.rulerViewport.scrollLeft).toBe(300);
	expect(scrub.tracksViewport.scrollLeft).toBe(300);
	expect(scrub.lineTransform()).toBe("translateX(99px)");
});

test("snap points are reused until the scene data changes and Shift bypasses the cache", () => {
	const scrub = setup();
	scrub.controller.onRulerPointerDown(scrub.event(47));
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
	scrub.controller.onRulerPointerDown(scrub.event(100));
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
	scrub.controller.onRulerPointerDown(scrub.event(50));
	scrub.seekExternally(time(1.1));
	scrub.move(51);
	scrub.frame();
	expect(scrub.seek).toEqual([time(1), time(1)]);
});

test("playback draws the live time during a scrub without centering the viewport", () => {
	const scrub = setup({ isPlaying: true, autoScroll: true });
	scrub.controller.onRulerPointerDown(scrub.event(50));
	// Space while the playhead is held plays again.
	scrub.play();
	scrub.controller.handlePlaybackUpdate(time(9), true);
	scrub.controller.handleScroll(time(9));
	expect(scrub.lineTime()).toBe(String(time(9)));
	expect(scrub.rulerViewport.scrollLeft).toBe(0);
	scrub.controller.handlePlaybackUpdate(time(9), false);
	expect(scrub.rulerViewport.scrollLeft).toBeGreaterThan(0);
});

test("a paused drag can seek back to a cached snap point after an external seek", () => {
	const scrub = setup();
	scrub.controller.onRulerPointerDown(scrub.event(50));
	scrub.move(51);
	scrub.frame();
	expect(scrub.seek).toEqual([time(1)]);
	scrub.seekExternally(time(3));
	scrub.move(52);
	scrub.frame();
	expect(scrub.seek).toEqual([time(1), time(1)]);
});

for (const interrupt of ["cancel", "loseCapture", "blur", "pagehide", "hide"] as const) {
	test(`ends the captured scrub on ${interrupt}, preserving the last pointer sample`, () => {
		const scrub = setup({ autoScroll: true });
		scrub.controller.onRulerPointerDown(scrub.event(50));
		expect(scrub.pointerCaptured()).toBe(true);
		scrub.move(145);
		scrub.moveOtherPointer(32);
		scrub[interrupt]();
		expect(scrub.pointerCaptured()).toBe(false);
		expect(scrub.seek.at(-1)).toBe(time(2.9));
		expect(scrub.saved).toEqual([time(2.9)]);
		expect(scrub.scrubbing).toEqual([true, false]);
		const left = scrub.rulerViewport.scrollLeft;
		scrub.frame();
		expect(scrub.rulerViewport.scrollLeft).toBe(left);
	});
}

test("a transient zero-button move keeps the captured scrub active through release", () => {
	const scrub = setup();
	scrub.controller.onRulerPointerDown(scrub.event(50));
	scrub.move(145, 0);
	scrub.frame();
	expect(scrub.controller.isActive).toBe(true);
	expect(scrub.pointerCaptured()).toBe(true);
	scrub.move(160);
	scrub.release(200);
	expect(scrub.saved).toEqual([time(4)]);
	expect(scrub.scrubbing).toEqual([true, false]);
});

test("scene and project navigation discard queued pointer samples from the old scope", () => {
	const scrub = setup();
	for (const navigate of [
		() => scrub.setScene("compound"),
		() => scrub.setProjectSession(2),
	]) {
		scrub.controller.onRulerPointerDown(scrub.event(50));
		scrub.move(145);
		scrub.seekExternally(time(4));
		navigate();
		scrub.release(145);
		scrub.frame();
		expect(scrub.controller.isActive).toBe(false);
		expect(scrub.seek.at(-1)).toBe(time(1));
		expect(scrub.saved).toEqual([]);
	}
});

test("updatePlayheadPosition without a line element does not read scrollLeft", () => {
	let scrollLeftReads = 0;
	const rulerViewport = {
		get scrollLeft() {
			scrollLeftReads++;
			return 0;
		},
	} as HTMLDivElement;
	const controller = new PlayheadController({
		configRef: { current: {
			zoomLevel: 1,
			getDuration: () => time(10),
			getCurrentTime: () => time(0),
			getSceneId: () => "main",
			getProjectSession: () => 1,
			getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
			isShiftHeld: () => false,
			isSnappingEnabled: () => true,
			getIsPlaying: () => false,
			getRulerEl: () => null,
			getRulerScrollEl: () => rulerViewport,
			getTracksScrollEl: () => null,
			getPlayheadEl: () => null,
			getSceneTracks: () => ({
				main: {
					id: "main", name: "Main", type: "video", muted: false, hidden: false,
					elements: [],
				},
				audio: [],
				overlay: [],
			}),
			getSceneBookmarks: () => [],
			seek: () => {},
			pause: () => {},
			setScrubbing: () => {},
			setTimelineViewState: () => {},
		} },
	});
	controller.updatePlayheadPosition(time(1));
	expect(scrollLeftReads).toBe(0);
	controller.destroy();
});

test("edits in the same scene invalidate snapping and use the new duration", () => {
	const scrub = setup();
	scrub.controller.onRulerPointerDown(scrub.event(50));
	scrub.move(49);
	scrub.frame();
	const reads = scrub.edgeReads();
	scrub.replaceTracks();
	scrub.setDuration(time(2));
	scrub.move(300);
	scrub.frame();
	expect(scrub.controller.isActive).toBe(true);
	expect(scrub.edgeReads()).toBeGreaterThan(reads);
	expect(scrub.seek.at(-1)).toBe(time(2));
});

test.each(["playhead", "ruler"] as const)("grabbing the %s during playback pauses it, and the release leaves it paused", (grabbed) => {
	const scrub = setup({ isPlaying: true });
	if (grabbed === "playhead") scrub.controller.onPlayheadPointerDown(scrub.event(50));
	else scrub.controller.onRulerPointerDown(scrub.event(50));
	expect(scrub.isPlaying()).toBe(false);
	scrub.move(100);
	scrub.frame();
	scrub.release(100);
	expect(scrub.isPlaying()).toBe(false);
	expect(scrub.pauses()).toBe(1);
	expect(scrub.seek.at(-1)).toBe(time(2));
	expect(scrub.saved).toEqual([time(2)]);
});

test("a scrub while paused does not pause again", () => {
	const scrub = setup();
	scrub.controller.onPlayheadPointerDown(scrub.event(50));
	scrub.release(50);
	expect(scrub.pauses()).toBe(0);
});
