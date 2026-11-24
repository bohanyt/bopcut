import { TracksSnapshotCommand } from "@/commands/timeline/tracks-snapshot";
import type { SceneTracks, UploadAudioElement } from "@/timeline";
import { buildUploadAudioElement } from "@/timeline/element-utils";
import { applyPlacement, resolveTrackPlacement } from "@/timeline/placement";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import { updateTrackInSceneTracks } from "@/timeline/track-element-update";
import { generateUUID } from "@/utils/id";
import type { MediaTime } from "@/wasm";

export type PlacedTake = { trackId: string; element: UploadAudioElement };
export type TakeAsset = { mediaId: string; name: string; duration: MediaTime };

export function findUneditedTake(tracks: SceneTracks, candidates: readonly PlacedTake[]) {
	// Timeline edits replace element objects. Undo can restore the original object;
	// an id alone would also match a clip the user moved, trimmed or split.
	return candidates.find(({ trackId, element }) =>
		tracks.audio.some((track) => track.id === trackId && track.elements.includes(element)),
	);
}

export function placeTake({
	tracks, take, startTime, candidates, preferredTrackId,
}: {
	tracks: SceneTracks;
	take: TakeAsset;
	startTime: MediaTime;
	candidates: readonly PlacedTake[];
	preferredTrackId?: string;
}) {
	const previous = findUneditedTake(tracks, candidates);
	const available = previous ? updateTrackInSceneTracks({
		tracks,
		trackId: previous.trackId,
		update: (track) => ({ ...track, elements: track.elements.filter((element) => element !== previous.element) }),
	}) : tracks;

	const { duration } = take;
	const timeSpans = [{ startTime, duration }];
	// A new take on a muted track would be silent in playback and export.
	const free = available.audio.filter((track) =>
		(!track.muted || track.id === previous?.trackId) && canPlaceTimeSpansOnTrack({ track, timeSpans }));
	const target = free.find((track) => track.id === (previous?.trackId ?? preferredTrackId)) ?? free[0];
	const placementResult = resolveTrackPlacement({
		tracks: available,
		trackType: "audio",
		timeSpans,
		strategy: target ? { type: "explicit", trackId: target.id } : { type: "alwaysNew", position: "highest" },
	});
	if (!placementResult) return null;

	const element: UploadAudioElement = {
		...buildUploadAudioElement({ ...take, startTime }),
		id: previous?.element.id ?? generateUUID(),
	};
	const placed = applyPlacement({ tracks: available, placementResult, elements: [element] });
	return placed ? {
		tracks: placed.updatedTracks,
		anchor: { trackId: placed.targetTrackId, element },
	} : null;
}

export class PlaceTakeCommand extends TracksSnapshotCommand {
	override readonly ripples = false;
}
