import type { SceneTracks, TimelineTrack } from "@/timeline/types";

export interface RippleAdjustment {
	trackId: string;
	afterTime: number;
	shiftAmount: number;
}

export function applyRippleAdjustments({
	tracks,
	adjustments,
}: {
	tracks: SceneTracks;
	adjustments: RippleAdjustment[];
}): SceneTracks {
	if (adjustments.length === 0) {
		return tracks;
	}

	const adjustmentsByTrack = new Map<string, RippleAdjustment[]>();
	for (const adjustment of adjustments) {
		const trackAdjustments = adjustmentsByTrack.get(adjustment.trackId) ?? [];
		trackAdjustments.push(adjustment);
		adjustmentsByTrack.set(adjustment.trackId, trackAdjustments);
	}

	return {
		overlay: tracks.overlay.map((track) =>
			applyTrackRippleAdjustments({
				track,
				adjustments: adjustmentsByTrack.get(track.id) ?? [],
			}),
		),
		main: applyTrackRippleAdjustments({
			track: tracks.main,
			adjustments: adjustmentsByTrack.get(tracks.main.id) ?? [],
		}),
		audio: tracks.audio.map((track) =>
			applyTrackRippleAdjustments({
				track,
				adjustments: adjustmentsByTrack.get(track.id) ?? [],
			}),
		),
	};
}

function applyTrackRippleAdjustments<
	TElement extends TimelineTrack["elements"][number],
	TTrack extends TimelineTrack & { elements: TElement[] },
>({
	track,
	adjustments,
}: {
	track: TTrack;
	adjustments: RippleAdjustment[];
}): TTrack {
	if (adjustments.length === 0) {
		return track;
	}

	const sortedAdjustments = [...adjustments].sort(
		(firstAdjustment, secondAdjustment) =>
			secondAdjustment.afterTime - firstAdjustment.afterTime,
	);

	// One pass: each clip takes the shifts in the order they used to be applied one by one, latest first.
	const elements = track.elements.map((element) => {
		let startTime: number = element.startTime;
		for (const { afterTime, shiftAmount } of sortedAdjustments) {
			if (startTime >= afterTime) startTime -= shiftAmount;
		}
		return startTime === element.startTime ? element : ({ ...element, startTime } as TElement);
	});

	return { ...track, elements };
}
