import { describe, expect, test } from "bun:test";
import type { Transform } from "@/rendering";
import type { SceneTracks, VideoElement } from "@/timeline";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import { buildResizeMembers } from "@/timeline/controllers/resize-controller";
import { computeGroupResize } from "@/timeline/group-resize";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";

function buildTransform(): Transform {
	return {
		scaleX: 1,
		scaleY: 1,
		position: { x: 0, y: 0 },
		rotate: 0,
	};
}

function buildVideoElement(
	overrides: Partial<VideoElement> = {},
): VideoElement {
	return {
		id: "video-1",
		type: "video",
		name: "Video 1",
		startTime: ZERO_MEDIA_TIME,
		duration: mediaTime({ ticks: 10 }),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		mediaId: "media-1",
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		},
		...overrides,
	};
}

function buildTracks(element: VideoElement): SceneTracks {
	return {
		overlay: [],
		main: {
			id: "main-track",
			type: "video",
			name: "Main",
			muted: false,
			hidden: false,
			elements: [element],
		},
		audio: [],
	};
}

describe("applyElementUpdate", () => {
	test("rounds retimed durations back to integer media time", () => {
		const element = buildVideoElement();
		const tracks = buildTracks(element);

		const updatedElement = applyElementUpdate({
			element,
			patch: {
				retime: { rate: 1.5 },
			},
			context: {
				tracks,
				trackId: tracks.main.id,
			},
		});

		expect(updatedElement.duration).toBe(mediaTime({ ticks: 7 }));
		expect(Number.isInteger(updatedElement.duration)).toBe(true);
	});
});

test("group trim stops at the gap between selected clips on one track", () => {
	const frame = 4000;
	const left = buildVideoElement({ id: "left", duration: mediaTime({ ticks: 2 * frame }) });
	const right = buildVideoElement({
		id: "right",
		startTime: mediaTime({ ticks: 3 * frame }),
		duration: left.duration,
	});
	const tracks = buildTracks(left);
	tracks.main.elements.push(right);
	const members = buildResizeMembers({
		tracks,
		selectedElements: tracks.main.elements.map((element) => ({ trackId: tracks.main.id, elementId: element.id })),
	});
	const result = computeGroupResize({
		members,
		side: "right",
		deltaTime: mediaTime({ ticks: 4 * frame }),
		fps: { numerator: 30, denominator: 1 },
	});
	expect(result.deltaTime).toBe(mediaTime({ ticks: frame }));
	const boundary = right.startTime;
	expect(result.updates.map(({ patch }) => [patch.startTime, patch.duration])).toEqual([
		[ZERO_MEDIA_TIME, boundary],
		[boundary, boundary],
	]);
});
