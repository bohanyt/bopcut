import { afterEach, expect, test } from "bun:test";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { CompoundElement, ElementRef, SceneTracks, TScene } from "@/timeline";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import {
	ElementInteractionController,
	type ElementInteractionDeps,
} from "@/timeline/controllers/element-interaction-controller";

const DRAG = TIMELINE_DRAG_THRESHOLD_PX + 2;

function compoundOnAudio(): { tracks: SceneTracks; scenes: TScene[]; compound: CompoundElement } {
	const inner: TScene = {
		id: "inner",
		name: "inner",
		isMain: false,
		kind: "compound",
		tracks: {
			overlay: [],
			main: { id: "m", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
			audio: [
				{
					id: "ia",
					name: "Inner Audio",
					type: "audio",
					muted: false,
					elements: [
						{
							id: "tone",
							type: "audio",
							name: "tone",
							mediaId: "tone",
							sourceType: "upload",
							startTime: ZERO_MEDIA_TIME,
							duration: mediaTime({ ticks: 60_000 }),
							trimStart: ZERO_MEDIA_TIME,
							trimEnd: ZERO_MEDIA_TIME,
							params: { volume: 0, muted: false },
						},
					],
				},
			],
		},
		bookmarks: [],
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const compound: CompoundElement = {
		id: "compound",
		type: "compound",
		name: "compound",
		sceneId: "inner",
		startTime: mediaTime({ ticks: 30_000 }),
		duration: mediaTime({ ticks: 60_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: mediaTime({ ticks: 60_000 }),
		params: { volume: 0, muted: false },
	};
	const tracks: SceneTracks = {
		overlay: [],
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
		audio: [{ id: "a1", name: "Audio", type: "audio", muted: false, elements: [compound] }],
	};
	const host: TScene = {
		id: "main",
		name: "main",
		isMain: true,
		tracks,
		bookmarks: [],
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	return { tracks, scenes: [host, inner], compound };
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

test("a horizontal drag of an audio-only compound stays on its audio track", () => {
	const { tracks, compound } = compoundOnAudio();
	const page = Object.assign(new EventTarget(), { activeElement: null });
	const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: page });
	const box = () => ({ left: 0, top: 0, width: 2000, height: 400 });
	const commits: Array<{ createTracks: unknown[]; moves: { targetTrackId: string }[] }> = [];
	const deps: ElementInteractionDeps = {
		viewport: {
			getZoomLevel: () => 1,
			getTracksScrollEl: () =>
				({ scrollLeft: 0, scrollTop: 0, getBoundingClientRect: box }) as HTMLDivElement,
			getTracksContainerEl: () => ({ getBoundingClientRect: box }) as HTMLDivElement,
			getHeaderEl: () => ({ getBoundingClientRect: () => ({ height: 0 }) }) as HTMLElement,
		},
		input: { isShiftHeld: () => false },
		scene: { getTracks: () => tracks, getActiveFps: () => ({ numerator: 30, denominator: 1 }) },
		selection: {
			getSelected: () => [{ trackId: "a1", elementId: "compound" }] satisfies ElementRef[],
			isSelected: () => true,
			select: () => {},
			handleClick: () => {},
			selectMany: () => {}, clearKeyframeSelection: () => {},
		},
		playback: { getCurrentTime: () => ZERO_MEDIA_TIME },
		timeline: {
			moveElements: (args) => {
				commits.push(args as { createTracks: unknown[]; moves: { targetTrackId: string }[] });
			},
			beginPreviewGesture: () => ({ finish: () => {}, cancel: () => {} }),
		},
		snap: { isEnabled: () => false },
	};
	const controller = new ElementInteractionController({ depsRef: { current: deps } });
	cleanup = () => {
		controller.destroy();
		if (prevDoc) Object.defineProperty(globalThis, "document", prevDoc);
		else Reflect.deleteProperty(globalThis, "document");
	};

	const leftPx = (compound.startTime / TICKS_PER_SECOND) * BASE_TIMELINE_PIXELS_PER_SECOND;
	const downX = leftPx + 5;
	const audioY = 65 + 6 + 25;

	controller.onElementMouseDown({
		event: {
			button: 0,
			clientX: downX,
			clientY: audioY,
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			stopPropagation: () => {},
			currentTarget: {
				ownerDocument: page,
				getBoundingClientRect: () => ({ left: downX, top: audioY, width: 200, height: 40 }),
			},
		} as unknown as ReactMouseEvent,
		element: compound,
		track: tracks.audio[0],
	});

	page.dispatchEvent(Object.assign(new Event("mousemove"), { clientX: downX + DRAG + 40, clientY: audioY }));
	page.dispatchEvent(
		Object.assign(new Event("mouseup"), { button: 0, clientX: downX + DRAG + 40, clientY: audioY }),
	);

	expect(commits.length).toBe(1);
	expect(commits[0].createTracks).toEqual([]);
	expect(commits[0].moves[0].targetTrackId).toBe("a1");
});