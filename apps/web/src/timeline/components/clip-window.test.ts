import { describe, expect, test } from "bun:test";
import type { TimelineTrack } from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import {
	mediaTimeFromSeconds,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { buildClipIndex } from "./clip-window";
import { getTrackClipIndex } from "./track-clip-index";
import { hitTestTimelineElements } from "./selection-hit-testing";
import {
	TIMELINE_CONTENT_TOP_PADDING_PX,
	TIMELINE_TRACK_GAP_PX,
} from "./layout";
import { getTrackHeight } from "./track-layout";

const clip = (id: string, start: number, seconds: number) => ({
	id,
	startTime: mediaTimeFromSeconds({ seconds: start }),
	duration: mediaTimeFromSeconds({ seconds }),
});

describe("timeline clip window", () => {
	test("finds intersecting clips in track order, including a long overlap and touching edges", () => {
		const clips = [
			clip("right", 53, 1),
			clip("left", 49, 1),
			clip("long", 0, 80),
			clip("gap", 30, 1),
			clip("inside", 52, 0.5),
			clip("later", 54, 1),
		];
		const index = buildClipIndex(clips);

		expect(index.query(50 * TICKS_PER_SECOND, 53 * TICKS_PER_SECOND)).toEqual([
			clips[0],
			clips[1],
			clips[2],
			clips[4],
		]);
		expect(index.query(81 * TICKS_PER_SECOND, 90 * TICKS_PER_SECOND)).toEqual(
			[],
		);
		expect(buildClipIndex([]).query(0, TICKS_PER_SECOND)).toEqual([]);
	});

	test("keeps pinned items in their original order and omits stale or duplicate IDs", () => {
		const clips = [
			clip("selected", 0, 1),
			clip("visible", 10, 1),
			clip("dragged", 1, 1),
			clip("hidden", 2, 1),
			clip("focused", 25, 1),
			clip("trimmed", 30, 1),
		];
		const index = buildClipIndex(clips);
		expect(
			index.query(10 * TICKS_PER_SECOND, 11 * TICKS_PER_SECOND, [
				"trimmed",
				"dragged",
				"focused",
				"visible",
				"selected",
				"deleted",
			]),
		).toEqual([clips[0], clips[1], clips[2], clips[4], clips[5]]);
	});

	test("box-selects unmounted clips on rows below an expanded track", () => {
		const makeTrack = (id: string, start: number): TimelineTrack => ({
			id,
			name: id,
			type: "video",
			hidden: false,
			muted: false,
			elements: [
				{
					...clip(id + "-clip", start, 1),
					name: id,
					type: "video",
					mediaId: "source",
					trimStart: ZERO_MEDIA_TIME,
					trimEnd: ZERO_MEDIA_TIME,
					params: {},
				},
			],
		});
		const tracks = [makeTrack("top", 300), makeTrack("bottom", 300)];
		const zoomLevel = 1;
		const far = timelineTimeToPixels({
			time: 300 * TICKS_PER_SECOND,
			zoomLevel,
		});
		const top =
			TIMELINE_CONTENT_TOP_PADDING_PX +
			getTrackHeight({ type: "video" }) +
			48 +
			TIMELINE_TRACK_GAP_PX;
		expect(
			getTrackClipIndex(tracks[1].elements).query(0, 10 * TICKS_PER_SECOND),
		).toEqual([]);
		expect(
			hitTestTimelineElements({
				tracks,
				zoomLevel,
				selectionRectangle: {
					left: far,
					right: far + 10,
					top,
					bottom: top + 10,
				},
				getTrackExpansionHeight: (trackIndex) => (trackIndex === 0 ? 48 : 0),
			}),
		).toEqual([{ trackId: "bottom", elementId: "bottom-clip" }]);
	});

	test("evicts indexes for old clip arrays retained by editing history", () => {
		const revisions: TimelineTrack["elements"][] = Array.from(
			{ length: 30 },
			() => [],
		);
		const oldest = getTrackClipIndex(revisions[0]);
		expect(getTrackClipIndex(revisions[0])).toBe(oldest);
		for (const elements of revisions.slice(1)) getTrackClipIndex(elements);
		expect(getTrackClipIndex(revisions[0])).not.toBe(oldest);
	});
});
