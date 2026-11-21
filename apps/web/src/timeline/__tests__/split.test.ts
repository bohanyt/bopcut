import { expect, test } from "bun:test";
import { clampAnimationsToDuration, getKeyframeAtTime, resolveAnimationPathValueAtTime } from "@/animation";
import { clipElementToRange } from "@/timeline/compound";
import { splitElementAt } from "@/timeline/split";
import type { TimelineElement, VideoElement } from "@/timeline";
import { t, video } from "./compound-fixtures";

function opacityClip(): VideoElement {
	return {
		...video("clip", 0, 5),
		params: { opacity: 1 },
		animations: {
			opacity: {
				keys: [
					{ id: "first", time: t(1), value: 0.2, segmentToNext: "linear", tangentMode: "auto" },
					{ id: "last", time: t(2), value: 0.4, segmentToNext: "linear", tangentMode: "auto" },
				],
			},
		},
	};
}

function readOpacity(element: TimelineElement, seconds: number) {
	return resolveAnimationPathValueAtTime({
		animations: element.animations,
		propertyPath: "opacity",
		localTime: t(seconds),
		fallbackValue: 1,
	});
}

test.each([0.5, 3])("split at %s seconds preserves both sides of a held channel", (splitTime) => {
	const clip = opacityClip();
	const parts = splitElementAt({ element: clip, splitTime: t(splitTime), rightId: "right" });
	if (!parts) throw new Error("Expected a split inside the clip");
	for (const time of [0, splitTime / 2, splitTime]) {
		expect(readOpacity(parts.left, time)).toBe(readOpacity(clip, time));
	}
	for (const time of [0, (5 - splitTime) / 2, 5 - splitTime]) {
		expect(readOpacity(parts.right, time)).toBe(readOpacity(clip, time + splitTime));
	}
});

test("clipping a child to the held tail of a compound keeps the animated value", () => {
	const clip = opacityClip();
	const clipped = clipElementToRange({ element: clip, rangeStart: t(3), rangeEnd: t(4) });
	if (!clipped) throw new Error("Expected a clipped child");
	expect(readOpacity(clipped, 0)).toBe(0.4);
	expect(readOpacity(clipped, 1)).toBe(0.4);
});

test("clamping beyond the last scalar key does not add a key to the non-empty side", () => {
	const clip = opacityClip();
	const animations = clampAnimationsToDuration({ animations: clip.animations, duration: t(3) });
	expect(getKeyframeAtTime({ animations, propertyPath: "opacity", time: t(3) })).toBeNull();
	expect(getKeyframeAtTime({ animations, propertyPath: "opacity", time: t(2) })?.id).toBe("last");
});
