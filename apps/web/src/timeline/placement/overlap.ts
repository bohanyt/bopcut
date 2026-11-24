import type { TimelineElement } from "@/timeline";
import type { PlacementTimeSpan } from "./types";

interface TrackWithElements {
	elements: TimelineElement[];
}

function wouldElementOverlap({
	elements,
	startTime,
	endTime,
	excludeElementId,
	excludeElementIds,
}: {
	elements: TimelineElement[];
	startTime: number;
	endTime: number;
	excludeElementId?: string;
	excludeElementIds?: ReadonlySet<string>;
}): boolean {
	return elements.some((element) => {
		if (element.id === excludeElementId || excludeElementIds?.has(element.id)) {
			return false;
		}

		const elementEnd = element.startTime + element.duration;
		return startTime < elementEnd && endTime > element.startTime;
	});
}

export function canPlaceTimeSpansOnTrack({
	track,
	timeSpans,
}: {
	track: TrackWithElements;
	timeSpans: PlacementTimeSpan[];
}): boolean {
	return timeSpans.every(({ startTime, duration, excludeElementId, excludeElementIds }) => {
		return !wouldElementOverlap({
			elements: track.elements,
			startTime,
			endTime: startTime + duration,
			excludeElementId,
			excludeElementIds,
		});
	});
}
