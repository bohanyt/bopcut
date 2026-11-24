import type { TimelineElement, TimelineTrack } from "@/timeline";
import { buildClipIndex } from "./clip-window";

export function createTrackClipIndexCache(
	build = buildClipIndex<TimelineElement>,
) {
	const recent = new Map<
		readonly TimelineElement[],
		ReturnType<typeof build>
	>();

	return {
		getTracks(tracks: readonly TimelineTrack[]) {
			const indexes = new Map(
				tracks.map(({ id, elements }) => {
					const index = recent.get(elements) ?? build(elements);
					recent.delete(elements);
					recent.set(elements, index);
					return [id, index] as const;
				}),
			);
			// Keep every active row and a bounded number of historical versions.
			const capacity = Math.max(16, tracks.length * 2);
			for (const elements of recent.keys()) {
				if (recent.size <= capacity) break;
				recent.delete(elements);
			}
			return indexes;
		},
	};
}

export type TrackClipIndexes = ReturnType<
	ReturnType<typeof createTrackClipIndexCache>["getTracks"]
>;
