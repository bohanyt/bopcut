import { expect, test } from "bun:test";
import type { SceneTracks, TimelineTrack, VideoElement } from "@/timeline";
import { computeDropTarget, getDropLineY } from "@/timeline/components/drop-target";
import { getTrackHeight, getCumulativeHeightBefore } from "@/timeline/components/track-layout";
import { TIMELINE_TRACK_GAP_PX } from "@/timeline/components/layout";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { mediaTime, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";

const EXPANSION_PX = 48;

function overlayTrack(): TimelineTrack {
	return {
		id: "overlay",
		name: "Overlay",
		type: "video",
		muted: false,
		hidden: false,
		elements: [
			{
				id: "clip",
				type: "video",
				name: "clip",
				mediaId: "clip",
				startTime: ZERO_MEDIA_TIME,
				duration: mediaTime({ ticks: 120_000 }),
				trimStart: ZERO_MEDIA_TIME,
				trimEnd: ZERO_MEDIA_TIME,
				params: {
					"transform.positionX": 0,
					"transform.positionY": 0,
					"transform.scaleX": 1,
					"transform.scaleY": 1,
					"transform.rotate": 0,
					opacity: 1,
				},
			} satisfies VideoElement,
		],
	};
}

function mainTrack(): TimelineTrack {
	return {
		id: "main",
		name: "Main",
		type: "video",
		muted: false,
		hidden: false,
		elements: [],
	};
}

const extra = (index: number) => (index === 0 ? EXPANSION_PX : 0);

test("the drop target counts a track's expanded keyframe lanes as part of its row", () => {
	const ordered = [overlayTrack(), mainTrack()];
	// Y = 100 is inside the expanded overlay row (base row plus its lanes), not on the main track.
	// X = 200 px (4 s) is past the overlay's clip, so the overlay track has room there.
	const drop = computeDropTarget({
		elementType: "video",
		mouseX: 200,
		mouseY: 100,
		tracks: { overlay: [ordered[0]], main: ordered[1], audio: [] } as unknown as SceneTracks,
		playheadTime: ZERO_MEDIA_TIME,
		isExternalDrop: false,
		elementDuration: mediaTime({ ticks: 30_000 }),
		pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
		zoomLevel: 1,
		getTrackExtraHeight: extra,
	});
	expect(drop).toMatchObject({ trackIndex: 0, isNewTrack: false });
});

test("the drop line below an expanded track is drawn below its lanes", () => {
	const ordered = [overlayTrack(), mainTrack()];
	const mainTop = getCumulativeHeightBefore({ tracks: ordered, trackIndex: 1, getExtraHeight: extra });
	const drop = computeDropTarget({
		elementType: "video",
		mouseX: 40,
		mouseY: mainTop + 4,
		tracks: { overlay: [ordered[0]], main: ordered[1], audio: [] } as unknown as SceneTracks,
		playheadTime: ZERO_MEDIA_TIME,
		isExternalDrop: true,
		elementDuration: mediaTime({ ticks: 30_000 }),
		pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
		zoomLevel: 1,
		verticalDragDirection: "down",
		getTrackExtraHeight: extra,
	});
	expect(getDropLineY({ dropTarget: drop, tracks: ordered, getTrackExtraHeight: extra }))
		.toBe(getTrackHeight({ type: "video" }) + EXPANSION_PX + TIMELINE_TRACK_GAP_PX);
});
