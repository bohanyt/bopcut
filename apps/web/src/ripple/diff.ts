import type { SceneTracks, TimelineElement, TimelineTrack } from "@/timeline/types";
import type { RippleAdjustment } from "./apply";

interface Interval {
	startTime: number;
	endTime: number;
}

interface ElementSpan extends Interval {
	id: string;
}

export function computeRippleAdjustments({
	beforeTracks,
	afterTracks,
}: {
	beforeTracks: SceneTracks;
	afterTracks: SceneTracks;
}): RippleAdjustment[] {
	const beforeTrackList = [
		...beforeTracks.overlay,
		beforeTracks.main,
		...beforeTracks.audio,
	];
	const afterTrackList = [
		...afterTracks.overlay,
		afterTracks.main,
		...afterTracks.audio,
	];
	const afterTracksById = new Map(afterTrackList.map((track) => [track.id, track]));
	// Built only when a clip left its track, to tell a move to another track from a removal.
	let allAfterElementIds: Set<string> | undefined;
	const isOnAnyTrack = (id: string) => {
		allAfterElementIds ??= new Set(
			afterTrackList.flatMap((track) => track.elements.map((element) => element.id)),
		);
		return allAfterElementIds.has(id);
	};

	return beforeTrackList.flatMap((beforeTrack): RippleAdjustment[] => {
		const afterElements = afterTracksById.get(beforeTrack.id)?.elements ?? [];
		// An untouched track frees nothing.
		if (afterElements === beforeTrack.elements) return [];
		return computeTrackRippleAdjustments({
			trackId: beforeTrack.id,
			beforeElements: beforeTrack.elements,
			afterElements,
			isOnAnyTrack,
		});
	});
}

function computeTrackRippleAdjustments({
	trackId,
	beforeElements,
	afterElements,
	isOnAnyTrack,
}: {
	trackId: string;
	beforeElements: TimelineElement[];
	afterElements: TimelineElement[];
	isOnAnyTrack: (id: string) => boolean;
}): RippleAdjustment[] {
	const beforeElementsById = buildElementSpanMap({ elements: beforeElements });
	const afterElementsById = buildElementSpanMap({ elements: afterElements });
	const { vacatedIntervals, occupiedIntervals } = collectTrackIntervals({
		beforeElementsById,
		afterElementsById,
		isOnAnyTrack,
	});
	const freedIntervals = subtractIntervalSets({
		sourceIntervals: vacatedIntervals,
		overlappingIntervals: occupiedIntervals,
	});

	return buildAdjustments({ trackId, intervals: freedIntervals });
}

function buildElementSpanMap({
	elements,
}: {
	elements: TimelineElement[];
}): Map<string, ElementSpan> {
	return new Map(
		elements.map((element) => [
			element.id,
			{
				id: element.id,
				startTime: element.startTime,
				endTime: element.startTime + element.duration,
			},
		]),
	);
}

function collectTrackIntervals({
	beforeElementsById,
	afterElementsById,
	isOnAnyTrack,
}: {
	beforeElementsById: Map<string, ElementSpan>;
	afterElementsById: Map<string, ElementSpan>;
	isOnAnyTrack: (id: string) => boolean;
}): {
	vacatedIntervals: Interval[];
	occupiedIntervals: Interval[];
} {
	const vacatedIntervals: Interval[] = [];
	const occupiedIntervals: Interval[] = [];
	let firstMovedStart = Infinity;
	let lastMovedEnd = -Infinity;

	for (const beforeElement of beforeElementsById.values()) {
		const afterElement = afterElementsById.get(beforeElement.id);
		if (!afterElement) {
			const wasMovedToAnotherTrack = isOnAnyTrack(beforeElement.id);
			if (!wasMovedToAnotherTrack) {
				pushInterval({
					intervals: vacatedIntervals,
					startTime: beforeElement.startTime,
					endTime: beforeElement.endTime,
				});
			}
			continue;
		}

		if (beforeElement.endTime > afterElement.endTime) {
			pushInterval({
				intervals: vacatedIntervals,
				startTime: afterElement.endTime,
				endTime: beforeElement.endTime,
			});
			if (afterElement.startTime < beforeElement.startTime) {
				firstMovedStart = Math.min(firstMovedStart, afterElement.startTime);
				lastMovedEnd = Math.max(lastMovedEnd, afterElement.endTime);
			}
		}
	}

	for (const afterElement of afterElementsById.values()) {
		const beforeElement = beforeElementsById.get(afterElement.id);
		if (beforeElement && (
			beforeElement.startTime !== afterElement.startTime ||
			beforeElement.endTime !== afterElement.endTime
		)) {
			continue;
		}

		pushInterval({
			intervals: occupiedIntervals,
			startTime: afterElement.startTime,
			endTime: afterElement.endTime,
		});
	}

	// Keep the group's new spacing intact while closing gaps left by the move.
	pushInterval({ intervals: occupiedIntervals, startTime: firstMovedStart, endTime: lastMovedEnd });

	// Nothing vacated frees nothing: the occupied spans need no sorting then.
	if (vacatedIntervals.length === 0) return { vacatedIntervals, occupiedIntervals: [] };
	return {
		vacatedIntervals: normalizeIntervals({ intervals: vacatedIntervals }),
		occupiedIntervals: normalizeIntervals({ intervals: occupiedIntervals }),
	};
}

function buildAdjustments({
	trackId,
	intervals,
}: {
	trackId: string;
	intervals: Interval[];
}): RippleAdjustment[] {
	return intervals.flatMap((interval): RippleAdjustment[] => {
		const shiftAmount = interval.endTime - interval.startTime;
		if (shiftAmount <= 0) {
			return [];
		}

		return [
			{
				trackId,
				afterTime: interval.endTime,
				shiftAmount,
			},
		];
	});
}

/** The parts of the sources that no overlapping interval covers. Both lists are normalized: sorted, disjoint. */
function subtractIntervalSets({
	sourceIntervals,
	overlappingIntervals,
}: {
	sourceIntervals: Interval[];
	overlappingIntervals: Interval[];
}): Interval[] {
	const freed: Interval[] = [];
	let first = 0;
	for (const source of sourceIntervals) {
		// Both lists ascend, so an interval that ends before this source ends before the next ones too.
		while (first < overlappingIntervals.length && overlappingIntervals[first].endTime <= source.startTime) first++;
		let cursor = source.startTime;
		for (let index = first; index < overlappingIntervals.length; index++) {
			const overlapping = overlappingIntervals[index];
			if (overlapping.startTime >= source.endTime) break;
			pushInterval({ intervals: freed, startTime: cursor, endTime: overlapping.startTime });
			cursor = Math.max(cursor, overlapping.endTime);
		}
		pushInterval({ intervals: freed, startTime: cursor, endTime: source.endTime });
	}
	return freed;
}

function normalizeIntervals({
	intervals,
}: {
	intervals: Interval[];
}): Interval[] {
	const validIntervals: Interval[] = [];
	for (const interval of intervals) {
		pushInterval({
			intervals: validIntervals,
			startTime: interval.startTime,
			endTime: interval.endTime,
		});
	}

	const sortedIntervals = validIntervals.sort(
		(leftInterval, rightInterval) =>
			leftInterval.startTime - rightInterval.startTime,
	);

	if (sortedIntervals.length === 0) {
		return [];
	}

	const mergedIntervals: Interval[] = [{ ...sortedIntervals[0] }];
	for (const interval of sortedIntervals.slice(1)) {
		const previousInterval = mergedIntervals[mergedIntervals.length - 1];
		if (interval.startTime <= previousInterval.endTime) {
			previousInterval.endTime = Math.max(
				previousInterval.endTime,
				interval.endTime,
			);
			continue;
		}

		mergedIntervals.push({ ...interval });
	}

	return mergedIntervals;
}

function pushInterval({
	intervals,
	startTime,
	endTime,
}: { intervals: Interval[]; startTime: number; endTime: number }): void {
	if (endTime <= startTime) {
		return;
	}

	intervals.push({ startTime, endTime });
}
