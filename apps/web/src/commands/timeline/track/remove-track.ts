import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SceneTracks } from "@/timeline";

export class RemoveTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(private trackId: string) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		const updatedTracks: SceneTracks = {
			...this.savedState,
			overlay: this.savedState.overlay.filter((track) => track.id !== this.trackId),
			audio: this.savedState.audio.filter((track) => track.id !== this.trackId),
		};
		if (
			updatedTracks.overlay.length === this.savedState.overlay.length &&
			updatedTracks.audio.length === this.savedState.audio.length
		) return { changed: false };
		editor.timeline.updateTracks(updatedTracks);
		const { selectedElements, selectedKeyframes, keyframeSelectionAnchor, selectedMaskPoints } =
			editor.selection.getSnapshot();
		const elements = selectedElements.filter(({ trackId }) => trackId !== this.trackId);
		const keyframes = selectedKeyframes.filter(({ trackId }) => trackId !== this.trackId);
		const anchor = keyframeSelectionAnchor?.trackId === this.trackId ? null : keyframeSelectionAnchor;
		const maskPoints = selectedMaskPoints?.trackId === this.trackId ? null : selectedMaskPoints;
		if (
			elements.length === selectedElements.length &&
			keyframes.length === selectedKeyframes.length &&
			anchor === keyframeSelectionAnchor &&
			maskPoints === selectedMaskPoints
		) return;
		return {
			selection: {
				selectedElements: elements,
				selectedKeyframes: keyframes,
				keyframeSelectionAnchor: anchor,
				selectedMaskPoints: maskPoints,
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
