import type { TimelineElement } from "@/timeline";
import { buildClipIndex } from "./clip-window";

// Timeline commands replace the arrays of changed tracks. Reuse each index
// across viewport frames and between drawing and spatial selection.
const trackIndexes = new WeakMap<
	readonly TimelineElement[],
	ReturnType<typeof buildClipIndex<TimelineElement>>
>();

export function getTrackClipIndex(elements: readonly TimelineElement[]) {
	let index = trackIndexes.get(elements);
	if (!index) {
		index = buildClipIndex(elements);
		trackIndexes.set(elements, index);
	}
	return index;
}
