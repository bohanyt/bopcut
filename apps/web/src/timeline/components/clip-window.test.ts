import { describe, expect, test } from "bun:test";
import type { TimelineTrack } from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import {
	mediaTimeFromSeconds,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { buildClipIndex } from "./clip-window";
import { createTrackClipIndexCache } from "./track-clip-index";
import {
	findTimelineFocusTarget,
	recoverTimelineFocus,
} from "./timeline-keyboard";
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

const makeTrack = (
	id: string,
	start: number,
): Extract<TimelineTrack, { type: "video" }> => ({
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
		const tracks = [makeTrack("top", 300), makeTrack("bottom", 300)];
		const indexes = createTrackClipIndexCache().getTracks(tracks);
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
		expect(indexes.get("bottom")!.query(0, 10 * TICKS_PER_SECOND)).toEqual([]);
		expect(
			hitTestTimelineElements({
				tracks,
				indexes,
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
		const cache = createTrackClipIndexCache();
		const old = makeTrack("track", 0);
		const oldest = cache.getTracks([old]).get(old.id);
		expect(cache.getTracks([old]).get(old.id)).toBe(oldest);
		for (let i = 1; i <= 30; i++) cache.getTracks([makeTrack("track", i)]);
		expect(cache.getTracks([old]).get(old.id)).not.toBe(oldest);
	});

	test("builds no indexes during drag and scrolling with 34 active tracks", () => {
		let builds = 0;
		const cache = createTrackClipIndexCache((elements) => {
			builds++;
			return buildClipIndex(elements);
		});
		const tracks = Array.from({ length: 34 }, (_, i) => {
			const track = makeTrack(String(i), 0);
			return {
				...track,
				elements: Array.from({ length: 550 }, (_, j) => ({
					...track.elements[0],
					...clip(`${i}-${j}`, j, 1),
				})),
			};
		});
		cache.getTracks(tracks);
		expect(builds).toBe(34);
		const sourceTrackIds = new Set(["8"]);
		for (let frame = 0; frame < 60; frame++) {
			const indexes = cache.getTracks(tracks);
			for (const track of tracks) {
				const pins = sourceTrackIds.has(track.id) ? ["8-0"] : [];
				expect(
					indexes
						.get(track.id)
						?.query(
							frame * TICKS_PER_SECOND,
							(frame + 1) * TICKS_PER_SECOND,
							pins,
						).length,
				).toBeGreaterThan(0);
			}
		}
		expect(builds).toBe(34);
	});
});

describe("timeline keyboard order", () => {
	const main = makeTrack("main", 0);
	const elements = ["no-control", "first", "last"].map((id) => ({
		...main.elements[0],
		id,
	}));
	const withControls = { ...main, elements };
	const withoutControls = makeTrack("plain", 0);
	const empty = { ...makeTrack("empty", 0), elements: [] };
	const tracks = [empty, withControls, withoutControls];
	const hasControl = ({ id }: TimelineTrack["elements"][number]) =>
		id === "first" || id === "last";
	const next = (
		from: { trackId: string; elementId?: string },
		direction: 1 | -1,
	) => findTimelineFocusTarget({ tracks, from, direction, hasControl });

	test("walks track buttons and clip controls in both directions", () => {
		expect(next({ trackId: "empty" }, 1)).toEqual({ trackId: "main" });
		expect(next({ trackId: "main" }, 1)).toEqual({
			trackId: "main",
			elementId: "first",
		});
		expect(next({ trackId: "main", elementId: "last" }, 1)).toEqual({
			trackId: "plain",
		});
		expect(next({ trackId: "plain" }, -1)).toEqual({
			trackId: "main",
			elementId: "last",
		});
		expect(next({ trackId: "main", elementId: "first" }, -1)).toEqual({
			trackId: "main",
		});
		expect(next({ trackId: "main" }, -1)).toEqual({ trackId: "empty" });
		expect(next({ trackId: "empty" }, -1)).toBeUndefined();
		expect(next({ trackId: "plain" }, 1)).toBeUndefined();
	});

	test("recovers deleted focus to a neighbor, track button, or surviving row", () => {
		const recover = (surviving: TimelineTrack[], elementId: string) =>
			recoverTimelineFocus({
				before: tracks,
				tracks: surviving,
				from: { trackId: "main", elementId },
				hasControl,
			});
		const onlyLast = {
			...withControls,
			elements: [elements[2]],
		};
		const onlyFirst = {
			...withControls,
			elements: [elements[1]],
		};
		expect(recover([empty, onlyLast, withoutControls], "first")).toEqual({
			trackId: "main",
			elementId: "last",
		});
		expect(recover([empty, onlyFirst, withoutControls], "last")).toEqual({
			trackId: "main",
			elementId: "first",
		});
		expect(
			recover(
				[empty, { ...withControls, elements: [] }, withoutControls],
				"first",
			),
		).toEqual({ trackId: "main" });
		expect(recover([empty, withoutControls], "first")).toEqual({
			trackId: "plain",
		});
	});
});
