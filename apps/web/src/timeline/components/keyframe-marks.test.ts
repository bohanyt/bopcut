import { expect, mock, test } from "bun:test";
import type { ElementKeyframe } from "@/animation/types";
import { getTimelinePixelsPerSecond } from "@/timeline/pixel-utils";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { getKeyframeIndicators, mergeOverlappingIndicators, KEYFRAME_MIN_GAP_PX } = await import("./timeline-element");

/** Face follow on a 60 s clip: a position key on both axes 10 times a second. */
const faceFollow: ElementKeyframe[] = ["transform.positionX", "transform.positionY"].flatMap((propertyPath) =>
	Array.from({ length: 600 }, (_, index) => ({
		propertyPath, id: `${propertyPath}-${index}`, time: Math.round((index / 10) * TICKS_PER_SECOND) as MediaTime,
		value: 0, interpolation: "linear",
	}) as ElementKeyframe),
);

function marks(zoomLevel: number) {
	const elementWidth = 60 * getTimelinePixelsPerSecond({ zoomLevel });
	const indicators = getKeyframeIndicators({
		keyframes: faceFollow, trackId: "t", elementId: "cam", displayedStartTime: 0 as MediaTime, zoomLevel, elementLeft: 0, elementWidth,
	});
	return { indicators, elementWidth };
}

test("a dense keyframe track shows about one mark per 8 px of clip, holding every key once", () => {
	// Keys 1 px apart at this zoom: one mark per 8 keys in time.
	const zoomLevel = 10 / getTimelinePixelsPerSecond({ zoomLevel: 1 });
	const { indicators, elementWidth } = marks(zoomLevel);
	expect(indicators.length).toBeLessThanOrEqual(Math.ceil(elementWidth / KEYFRAME_MIN_GAP_PX) + 1);
	const held = indicators.flatMap((indicator) => indicator.keyframes.map((keyframe) => keyframe.keyframeId));
	expect(held.length).toBe(faceFollow.length);
	expect(new Set(held).size).toBe(faceFollow.length);
});

test("zoomed in far enough, each moment keeps its own mark", () => {
	// 10 px between keys.
	const zoomLevel = 100 / getTimelinePixelsPerSecond({ zoomLevel: 1 });
	const { indicators } = marks(zoomLevel);
	expect(indicators.length).toBe(600);
	expect(indicators.every((indicator) => indicator.keyframes.length === 2)).toBe(true);
});

test("marks merge into the first one shown, not into a moving chain", () => {
	const at = (offsetPx: number) => ({ time: offsetPx as MediaTime, offsetPx, keyframes: [{ trackId: "t", elementId: "e", propertyPath: "opacity", keyframeId: `k${offsetPx}` }] });
	const merged = mergeOverlappingIndicators([at(0), at(5), at(10), at(15), at(16)]);
	expect(merged.map((mark) => [mark.offsetPx, mark.keyframes.length])).toEqual([[0, 2], [10, 3]]);
});
