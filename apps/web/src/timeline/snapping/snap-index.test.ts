import { expect, test } from "bun:test";
import { buildSnapIndex, resolveIndexedSnap } from "./snap-index";
import { resolveTimelineSnap } from "./resolve";
import type { SnapPoint } from "./types";
import { mediaTime } from "@/wasm";

/** A small deterministic generator, so a failure repeats. */
function random(seed: number) {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
}

test("the index answers as the linear scan does, ties to the point listed first included", () => {
	const next = random(7);
	for (let round = 0; round < 200; round++) {
		// Few distinct times, so equal times and equal distances on both sides are common.
		const points: SnapPoint[] = Array.from({ length: Math.floor(next() * 40) }, (_, index) => ({
			time: mediaTime({ ticks: Math.floor(next() * 20) * 1000 }),
			type: index % 2 ? "element-start" : "element-end",
			elementId: String(index),
		}));
		const index = buildSnapIndex({ points });
		for (let query = 0; query < 20; query++) {
			const targetTime = mediaTime({ ticks: Math.floor(next() * 42) * 500 - 500 });
			const maxSnapDistance = Math.floor(next() * 4) * 1000;
			const linear = resolveTimelineSnap({ targetTime, snapPoints: points, maxSnapDistance });
			const indexed = resolveIndexedSnap({ targetTime, index, maxSnapDistance });
			expect(indexed.snapPoint).toBe(linear.snapPoint);
			expect(indexed.snappedTime).toBe(linear.snappedTime);
			expect(indexed.snapDistance).toBe(linear.snapDistance);
		}
	}
});
