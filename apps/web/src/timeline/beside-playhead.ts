import type { ElementRef, SceneTracks, TimelineTrack } from "@/timeline/types";
import { addMediaTime, type MediaTime } from "@/wasm";

/**
 * The clips on one side of the playhead, on every track that is not hidden, together with the clips
 * under it (as in other editors): on the right, those that end after it; on the left, those that
 * start before it. A clip that only touches the playhead with its edge is on the other side only.
 */
export function elementsBesidePlayhead({ tracks, time, side, onTracks }: {
	tracks: SceneTracks; time: MediaTime; side: "left" | "right";
	/** Only these tracks (unset: every track). */
	onTracks?: ReadonlySet<string>;
}): ElementRef[] {
	const shown = (track: TimelineTrack) => !("hidden" in track && track.hidden) && (!onTracks || onTracks.has(track.id));
	return [...tracks.overlay, tracks.main, ...tracks.audio].filter(shown).flatMap((track) =>
		track.elements
			.filter((element) => side === "right" ? addMediaTime({ a: element.startTime, b: element.duration }) > time : element.startTime < time)
			.map((element) => ({ trackId: track.id, elementId: element.id })),
	);
}
