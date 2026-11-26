import { expect, test } from "bun:test";
import { buildResizeMembers } from "@/timeline/controllers/resize-controller";
import { computeGroupResize } from "@/timeline/group-resize";
import type { AudioElement, SceneTracks } from "@/timeline";
import { addMediaTime, mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import type { ResizeSide } from "@/timeline/group-resize/types";

const fps = { numerator: 30, denominator: 1 };

function tracks(): SceneTracks {
	const short: AudioElement = {
		id: "short",
		type: "audio",
		name: "short",
		mediaId: "short",
		sourceType: "upload",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 3000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: mediaTime({ ticks: 3000 }),
		params: { volume: 0, muted: false },
	};
	const after: AudioElement = {
		id: "after",
		type: "audio",
		name: "after",
		mediaId: "after",
		sourceType: "upload",
		startTime: mediaTime({ ticks: 3000 }),
		duration: mediaTime({ ticks: 120_000 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: { volume: 0, muted: false },
	};
	return {
		overlay: [],
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
		audio: [{ id: "a", name: "Audio", type: "audio", muted: false, elements: [short, after] }],
	};
}

function resize(side: ResizeSide, ticks: number) {
	const members = buildResizeMembers({ tracks: tracks(), selectedElements: [{ trackId: "a", elementId: "short" }] });
	return computeGroupResize({ members, side, deltaTime: mediaTime({ ticks }), fps });
}

test("a clip shorter than a frame, closed in by its source and neighbour, is not resized past them", () => {
	for (const [side, ticks] of [["right", 1], ["right", 50_000], ["right", -2000], ["left", 1], ["left", -50_000]] as const) {
		const { deltaTime, updates } = resize(side, ticks);
		const patch = updates[0].patch;
		expect(deltaTime).toBe(ZERO_MEDIA_TIME);
		expect(patch.duration ?? mediaTime({ ticks: 3000 })).toBe(mediaTime({ ticks: 3000 }));
		expect(addMediaTime({ a: patch.startTime ?? ZERO_MEDIA_TIME, b: patch.duration ?? mediaTime({ ticks: 3000 }) }))
			.toBeLessThanOrEqual(mediaTime({ ticks: 3000 }));
	}
});

test("a clip of normal length still resizes by whole frames", () => {
	const members = buildResizeMembers({ tracks: tracks(), selectedElements: [{ trackId: "a", elementId: "after" }] });
	const { deltaTime } = computeGroupResize({ members, side: "right", deltaTime: mediaTime({ ticks: -10_000 }), fps });
	expect(deltaTime).toBe(mediaTime({ ticks: -8000 }));
});
