import { afterEach, expect, test } from "bun:test";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { AudioElement, ElementRef, SceneTracks } from "@/timeline";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME, type MediaTime } from "@/wasm";
import {
	ElementInteractionController,
	type ElementInteractionDeps,
} from "@/timeline/controllers/element-interaction-controller";

const DRAG = TIMELINE_DRAG_THRESHOLD_PX + 2;
const FPS = { numerator: 30, denominator: 1 };
const TICKS_PER_FRAME = Math.round((TICKS_PER_SECOND * FPS.denominator) / FPS.numerator);

const PLAYHEAD = mediaTime({ ticks: 480_000 });
// A clip 10 ticks short of 70 frames (an audio file rarely ends on a frame).
const DURATION = mediaTime({ ticks: 279_960 });
// Frame 54. A 7 px drag to the left (16 800 ticks) brings the end 40 ticks short of the playhead.
const START = mediaTime({ ticks: 216_000 });

function clip(id: string): AudioElement {
	return {
		id,
		type: "audio",
		name: id,
		mediaId: `media-${id}`,
		sourceType: "upload",
		startTime: START,
		duration: DURATION,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { volume: 0, muted: false },
	};
}

function sceneTracks(): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main",
			name: "Main",
			type: "video",
			muted: false,
			hidden: false,
			elements: [],
		},
		audio: [{ id: "a1", name: "Audio", type: "audio", muted: false, elements: [clip("sfx")] }],
	};
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function isOnFrameGrid(time: MediaTime): boolean {
	return time % TICKS_PER_FRAME === 0;
}

function harness() {
	const page = Object.assign(new EventTarget(), { activeElement: null });
	const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: page });
	const box = () => ({ left: 0, top: 0, width: 2000, height: 400 });
	const tracks = sceneTracks();
	const commits: Array<{ moves: { newStartTime: MediaTime }[] }> = [];
	const deps: ElementInteractionDeps = {
		viewport: {
			getZoomLevel: () => 1,
			getTracksScrollEl: () =>
				({ scrollLeft: 0, scrollTop: 0, getBoundingClientRect: box }) as HTMLDivElement,
			getTracksContainerEl: () => ({ getBoundingClientRect: box }) as HTMLDivElement,
			getHeaderEl: () => ({ getBoundingClientRect: () => ({ height: 0 }) }) as HTMLElement,
		},
		input: { isShiftHeld: () => false },
		scene: { getTracks: () => tracks, getActiveFps: () => FPS },
		selection: {
			getSelected: () => [{ trackId: "a1", elementId: "sfx" }] satisfies ElementRef[],
			isSelected: () => true,
			select: () => {},
			handleClick: () => {},
			selectMany: () => {}, clearKeyframeSelection: () => {},
		},
		playback: { getCurrentTime: () => PLAYHEAD },
		timeline: {
			moveElements: (args) => {
				commits.push(args as { moves: { newStartTime: MediaTime }[] });
			},
			beginPreviewGesture: () => ({ finish: () => {}, cancel: () => {} }),
		},
		snap: { isEnabled: () => true },
	};
	const controller = new ElementInteractionController({ depsRef: { current: deps } });
	cleanup = () => {
		controller.destroy();
		if (prevDoc) Object.defineProperty(globalThis, "document", prevDoc);
		else Reflect.deleteProperty(globalThis, "document");
	};

	const clipLeftPx = (START / TICKS_PER_SECOND) * BASE_TIMELINE_PIXELS_PER_SECOND;
	const clipRightPx =
		((START + DURATION) / TICKS_PER_SECOND) * BASE_TIMELINE_PIXELS_PER_SECOND;
	const downX = clipRightPx - 2;
	const audioTrackY = 65 + 6 + 25;

	controller.onElementMouseDown({
		event: {
			button: 0,
			clientX: downX,
			clientY: audioTrackY,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			stopPropagation: () => {},
			currentTarget: {
				ownerDocument: page,
				getBoundingClientRect: () => ({
					left: clipLeftPx,
					top: audioTrackY,
					width: clipRightPx - clipLeftPx,
					height: 40,
				}),
			},
		} as unknown as ReactMouseEvent,
		element: tracks.audio[0].elements[0],
		track: tracks.audio[0],
	});

	const dragX = downX - DRAG;
	page.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: dragX, clientY: audioTrackY }));
	page.dispatchEvent(
		Object.assign(new Event("mouseup"), { button: 0, clientX: dragX, clientY: audioTrackY }),
	);
	return commits;
}

test("a dragged clip whose end snaps to the playhead keeps its start on the frame grid", () => {
	const commits = harness();
	expect(commits.length).toBe(1);
	const newStart = commits[0].moves[0].newStartTime;
	// Snapping the end to the playhead gives 200 040 ticks; the start rounds to frame 50, so the
	// end lands within half a frame of the playhead.
	expect(isOnFrameGrid(newStart)).toBe(true);
	expect(newStart).toBe(mediaTime({ ticks: 200_000 }));
	expect(Math.abs(newStart + DURATION - PLAYHEAD)).toBeLessThanOrEqual(TICKS_PER_FRAME / 2);
});
