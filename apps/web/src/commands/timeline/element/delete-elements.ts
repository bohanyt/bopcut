import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks } from "@/timeline";
import { EditorCore } from "@/core";
import type { TimelineTrack } from "@/timeline";

function removeTrackElements<TTrack extends TimelineTrack>({
	track,
	elements,
}: {
	track: TTrack;
	elements: { trackId: string; elementId: string }[];
}): TTrack {
	const nextElements = track.elements.filter(
		(element) =>
			!elements.some(
				(target) =>
					target.trackId === track.id && target.elementId === element.id,
			),
	);

	return nextElements.length === track.elements.length ? track : { ...track, elements: nextElements };
}

export class DeleteElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly elements: { trackId: string; elementId: string }[];

	constructor({
		elements,
	}: {
		elements: { trackId: string; elementId: string }[];
	}) {
		super();
		this.elements = elements;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const before = editor.scenes.getActiveScene().tracks;
		this.savedState = before;

		const updatedTracks: SceneTracks = {
			overlay: before.overlay.map((track) =>
				removeTrackElements({ track, elements: this.elements }),
			),
			main: removeTrackElements({
				track: before.main,
				elements: this.elements,
			}),
			audio: before.audio.map((track) =>
				removeTrackElements({ track, elements: this.elements }),
			),
		};

		if (
			updatedTracks.main === before.main &&
			updatedTracks.overlay.every((track, index) => track === before.overlay[index]) &&
			updatedTracks.audio.every((track, index) => track === before.audio[index])
		) return { changed: false };
		editor.timeline.updateTracks(updatedTracks);

		return {
			selection: {
				selectedElements: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		};
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
