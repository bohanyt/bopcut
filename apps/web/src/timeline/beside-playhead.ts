import type { ElementRef, SceneTracks, TimelineTrack } from "@/timeline/types";
import { addMediaTime, type MediaTime } from "@/wasm";

/**
 * The clips wholly on one side of the playhead, on every track that is not hidden: on the right,
 * those that start at or after it; on the left, those that end at or before it. A clip under the
 * playhead is on neither side.
 */
export function elementsBesidePlayhead({ tracks, time, side }: { tracks: SceneTracks; time: MediaTime; side: "left" | "right" }): ElementRef[] {
	const shown = (track: TimelineTrack) => !("hidden" in track && track.hidden);
	return [...tracks.overlay, tracks.main, ...tracks.audio].filter(shown).flatMap((track) =>
		track.elements
			.filter((element) => side === "right" ? element.startTime >= time : addMediaTime({ a: element.startTime, b: element.duration }) <= time)
			.map((element) => ({ trackId: track.id, elementId: element.id })),
	);
}
