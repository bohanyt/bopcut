import { afterEach, expect, test } from "bun:test";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ElementRef, SceneTracks, VideoElement } from "@/timeline";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { ElementInteractionController, type ElementInteractionDeps } from "./element-interaction-controller";

const DRAG = TIMELINE_DRAG_THRESHOLD_PX + 2;
const video = (id: string, start = 0): VideoElement => ({
	id, type: "video", name: id, mediaId: id,
	startTime: mediaTime({ ticks: start }), duration: mediaTime({ ticks: 30_000 }),
	trimStart: ZERO_MEDIA_TIME, trimEnd: ZERO_MEDIA_TIME,
	params: { "transform.positionX": 0, "transform.positionY": 0, "transform.scaleX": 1, "transform.scaleY": 1, "transform.rotate": 0, opacity: 1 },
});
const scene = (elements: VideoElement[]): SceneTracks => ({
	main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements }, audio: [], overlay: [],
});
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function harness(initial: SceneTracks, selected: ElementRef[]) {
	let tracks = initial;
	const page = Object.assign(new EventTarget(), { activeElement: null });
	const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: page });
	const box = () => ({ left: 0, top: 0, width: 800, height: 400 });
	const commits: unknown[] = [];
	const deps: ElementInteractionDeps = {
		viewport: {
			getZoomLevel: () => 1,
			getTracksScrollEl: () => ({ scrollLeft: 0, getBoundingClientRect: box }) as HTMLDivElement,
			getTracksContainerEl: () => ({ getBoundingClientRect: box }) as HTMLDivElement,
			getHeaderEl: () => ({ getBoundingClientRect: () => ({ height: 0 }) }) as HTMLElement,
		},
		input: { isShiftHeld: () => false },
		scene: { getTracks: () => tracks, getActiveFps: () => ({ numerator: 30, denominator: 1 }) },
		selection: {
			getSelected: () => selected,
			isSelected: (ref) => selected.some((s) => s.elementId === ref.elementId && s.trackId === ref.trackId),
			select: () => {}, handleClick: () => {}, clearKeyframeSelection: () => {},
		},
		playback: { getCurrentTime: () => ZERO_MEDIA_TIME },
		timeline: { moveElements: (args) => { commits.push(args); }, beginPreviewGesture: () => ({ finish: () => {}, cancel: () => {} }) },
		snap: { isEnabled: () => false },
	};
	const controller = new ElementInteractionController({ depsRef: { current: deps } });
	cleanup = () => { controller.destroy(); if (prevDoc) Object.defineProperty(globalThis, "document", prevDoc); else Reflect.deleteProperty(globalThis, "document"); };
	const mouseDown = (id: string) => {
		const el = tracks.main.elements.find((e) => e.id === id)!;
		controller.onElementMouseDown({
			event: {
				button: 0, clientX: 100, clientY: 100, metaKey: false, ctrlKey: false, shiftKey: false,
				stopPropagation: () => {},
				currentTarget: { ownerDocument: page, getBoundingClientRect: () => ({ left: 100, top: 100 }) },
			} as unknown as ReactMouseEvent,
			element: el, track: tracks.main,
		});
	};
	const dragAndUp = (beforeUp?: (h: { setTracks: (n: SceneTracks) => void }) => void) => {
		page.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: 100 + DRAG, clientY: 100 }));
		beforeUp?.({ setTracks: (n) => { tracks = n; } });
		page.dispatchEvent(Object.assign(new Event("mouseup"), { button: 0, clientX: 100 + DRAG * 2, clientY: 100 }));
	};
	const move = (clientX: number, clientY: number) => page.dispatchEvent(Object.assign(new Event("mousemove"), { clientX, clientY }));
	return { commits, mouseDown, dragAndUp, move, controller, idle: () => controller.view.kind === "idle" };
}

test("normal drag commits moveElements once", () => {
	const h = harness(scene([video("a")]), [{ trackId: "main", elementId: "a" }]);
	h.mouseDown("a"); h.dragAndUp();
	expect(h.commits.length).toBe(1); expect(h.idle()).toBe(true);
});
test("clip removed before mouseup does not commit", () => {
	const h = harness(scene([video("a")]), [{ trackId: "main", elementId: "a" }]);
	h.mouseDown("a"); h.dragAndUp((x) => x.setTracks(scene([])));
	expect(h.commits.length).toBe(0); expect(h.idle()).toBe(true);
});
test("track removed before mouseup does not commit", () => {
	const main = scene([video("a")]).main;
	const h = harness(scene([video("a")]), [{ trackId: "main", elementId: "a" }]);
	h.mouseDown("a"); h.dragAndUp((x) => x.setTracks({ ...scene([video("a")]), main: { ...main, id: "replaced" } }));
	expect(h.commits.length).toBe(0); expect(h.idle()).toBe(true);
});
test("one of two dragged clips removed before mouseup does not commit", () => {
	const h = harness(scene([video("a"), video("b", 60_000)]), [{ trackId: "main", elementId: "a" }, { trackId: "main", elementId: "b" }]);
	h.mouseDown("a"); h.dragAndUp((x) => x.setTracks(scene([video("a")])));
	expect(h.commits.length).toBe(0); expect(h.idle()).toBe(true);
});

test("the drag view stays the same object while what it shows is the same, and the pointer x is live", () => {
	const h = harness(scene([video("a"), video("b", 60_000)]), [{ trackId: "main", elementId: "a" }]);
	h.mouseDown("a");
	h.move(100 + DRAG, 100);
	const first = h.controller.view;
	h.move(100 + DRAG + 0.2, 100);
	expect(h.controller.view).toBe(first);
	expect(h.controller.getPointerX()).toBe(100 + DRAG + 0.2);
	h.move(100 + DRAG + 40, 100);
	const later = h.controller.view;
	expect(later).not.toBe(first);
	if (first.kind !== "dragging" || later.kind !== "dragging") throw new Error("Expected a drag");
	// The moving clips and their tracks are worked out once per drag.
	expect(later.memberTimeOffsets).toBe(first.memberTimeOffsets);
	h.move(100 + DRAG + 40, 130);
	expect(h.controller.view).not.toBe(later);
	// Release, so the drag's timeline gesture ends with the test.
	h.dragAndUp();
	expect(h.idle()).toBe(true);
});
