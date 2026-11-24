import type { TimelineElement } from "@/timeline";
import { buildClipIndex } from "./clip-window";

// Undo history retains old element arrays. Limit the number of reusable
// indexes so the cache does not grow with the number of edits.
const MAX_RECENT_TRACK_INDEXES = 16;
const trackIndexes = new Map<
	readonly TimelineElement[],
	ReturnType<typeof buildClipIndex<TimelineElement>>
>();

export function getTrackClipIndex(elements: readonly TimelineElement[]) {
	const existing = trackIndexes.get(elements);
	const index = existing ?? buildClipIndex(elements);
	if (existing) trackIndexes.delete(elements);
	trackIndexes.set(elements, index);
	if (trackIndexes.size > MAX_RECENT_TRACK_INDEXES) {
		const oldest = trackIndexes.keys().next().value;
		if (oldest) trackIndexes.delete(oldest);
	}
	return index;
}
