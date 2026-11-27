import type { SnapPoint, SnapResult } from "./types";
import type { MediaTime } from "@/wasm";

export function resolveTimelineSnap({
	targetTime,
	snapPoints,
	maxSnapDistance,
}: {
	targetTime: MediaTime;
	snapPoints: SnapPoint[];
	maxSnapDistance: number;
}): SnapResult {
	let closestSnapPoint: SnapPoint | null = null;
	let closestDistance = Infinity;

	for (const snapPoint of snapPoints) {
		const distance = Math.abs(targetTime - snapPoint.time);
		if (distance <= maxSnapDistance && distance < closestDistance) {
			closestDistance = distance;
			closestSnapPoint = snapPoint;
		}
	}

	return {
		snappedTime: closestSnapPoint ? closestSnapPoint.time : targetTime,
		snapPoint: closestSnapPoint,
		snapDistance: closestDistance,
	};
}

/** The same point, whether or not it is the same object (gestures build fresh points on every move). */
export function sameSnapPoint({ a, b }: { a: SnapPoint | null; b: SnapPoint | null }): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.time === b.time && a.type === b.type && a.elementId === b.elementId && a.trackId === b.trackId;
}
