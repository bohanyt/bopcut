// Cutting a time range out of a timeline: every track loses what plays in it and everything after it
// moves up to close the gap (pure).
import type { Bookmark, SceneTracks, TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";
import { splitElementAt } from "@/timeline/split";

export type RangeCut = {
	tracks: SceneTracks;
	/** Elements wholly inside the range, now gone. */
	removed: TimelineElement[];
	/** Elements partly inside the range, as they were (their kept parts are in `kept`). */
	trimmed: TimelineElement[];
	/** The parts of trimmed elements that stay (a clip across the whole range keeps two). */
	kept: TimelineElement[];
	/** Elements after the range, as they were (now earlier by its length). */
	shifted: TimelineElement[];
};

/**
 * Cuts [start, end) out of the tracks. A clip across a boundary is split there (the same split as the
 * editor's), a part inside the range is dropped, and everything after `end` moves `end - start`
 * earlier. A clip that starts inside the range and goes on keeps its id; a clip across the whole range
 * keeps its id on the part before and gives `newId()` to the part after.
 */
export function cutRange({ tracks, start, end, newId }: { tracks: SceneTracks; start: MediaTime; end: MediaTime; newId: () => string }): RangeCut {
	const length = (end - start) as MediaTime;
	const removed: TimelineElement[] = [];
	const trimmed: TimelineElement[] = [];
	const kept: TimelineElement[] = [];
	const shifted: TimelineElement[] = [];
	const cutTrack = <T extends { elements: TimelineElement[] }>(track: T): T => {
		const elements = track.elements.flatMap((element): TimelineElement[] => {
			const elementEnd = element.startTime + element.duration;
			if (elementEnd <= start) return [element];
			if (element.startTime >= end) {
				shifted.push(element);
				return [{ ...element, startTime: (element.startTime - length) as MediaTime }];
			}
			if (element.startTime >= start && elementEnd <= end) {
				removed.push(element);
				return [];
			}
			trimmed.push(element);
			const parts: TimelineElement[] = [];
			let rest: TimelineElement = element;
			if (element.startTime < start) {
				const split = splitElementAt({ element, splitTime: start, rightId: newId() });
				if (split) {
					parts.push(split.left);
					rest = split.right;
				}
			}
			if (rest.startTime + rest.duration > end) {
				const split = splitElementAt({ element: rest, splitTime: end, rightId: rest.id });
				if (split) {
					// The part after the range: the original's id when the clip started inside the range.
					const tailId = rest === element ? element.id : rest.id;
					parts.push({ ...split.right, id: tailId, startTime: start });
				}
			}
			kept.push(...parts);
			return parts;
		});
		return { ...track, elements };
	};
	return {
		tracks: { ...tracks, overlay: tracks.overlay.map(cutTrack), main: cutTrack(tracks.main), audio: tracks.audio.map(cutTrack) },
		removed,
		trimmed,
		kept,
		shifted,
	};
}

/** Notes after the range move up with the timeline; notes inside it move to where it was cut. */
export function cutRangeBookmarks(bookmarks: Bookmark[], start: MediaTime, end: MediaTime): Bookmark[] {
	const length = end - start;
	return bookmarks.map((bookmark) => {
		if (bookmark.time < start) return bookmark;
		if (bookmark.time >= end) return { ...bookmark, time: (bookmark.time - length) as MediaTime };
		return { ...bookmark, time: start };
	});
}
