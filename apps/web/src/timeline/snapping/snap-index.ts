import type { SnapPoint, SnapResult } from "./types";
import type { MediaTime } from "@/wasm";

/** Snap points sorted by time, so a query looks only at the points within its reach. */
export interface SnapIndex {
	points: SnapPoint[];
	/** Indexes into `points`, by time and then by their order in `points`. */
	order: number[];
}

export function buildSnapIndex({ points }: { points: SnapPoint[] }): SnapIndex {
	const order = points.map((_, index) => index);
	order.sort((a, b) => points[a].time - points[b].time || a - b);
	return { points, order };
}

/**
 * The same answer as `resolveTimelineSnap` over `index.points`: the nearest point within reach,
 * and of equally near points the one listed first.
 */
export function resolveIndexedSnap({
	targetTime,
	index: { points, order },
	maxSnapDistance,
}: {
	targetTime: MediaTime;
	index: SnapIndex;
	maxSnapDistance: number;
}): SnapResult {
	let low = 0;
	let high = order.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (points[order[middle]].time < targetTime - maxSnapDistance) low = middle + 1;
		else high = middle;
	}

	let closest = -1;
	let closestDistance = Infinity;
	for (let position = low; position < order.length; position++) {
		const pointIndex = order[position];
		const point = points[pointIndex];
		if (point.time > targetTime + maxSnapDistance) break;
		const distance = Math.abs(targetTime - point.time);
		if (distance > maxSnapDistance) continue;
		if (distance < closestDistance || (distance === closestDistance && pointIndex < closest)) {
			closestDistance = distance;
			closest = pointIndex;
		}
	}

	const snapPoint = closest < 0 ? null : points[closest];
	return {
		snappedTime: snapPoint ? snapPoint.time : targetTime,
		snapPoint,
		snapDistance: closestDistance,
	};
}
