import { Command, createElementSelectionResult, type CommandResult } from "@/commands/base-command";
import type { ElementRef, SceneTracks } from "@/timeline";
import { EditorCore } from "@/core";

export class TracksSnapshotCommand extends Command {
	override readonly ripples: boolean;

	constructor({
		before,
		after,
		selectedElements,
		ripples = true,
	}: {
		before: SceneTracks;
		after: SceneTracks;
		selectedElements?: ElementRef[];
		ripples?: boolean;
	}) {
		super();
		this.before = before;
		this.after = after;
		this.selectedElements = selectedElements;
		this.ripples = ripples;
	}

	private before: SceneTracks;
	private after: SceneTracks;
	private selectedElements?: ElementRef[];

	execute(): CommandResult | undefined {
		EditorCore.getInstance().timeline.updateTracks(this.after);
		return this.selectedElements ? createElementSelectionResult(this.selectedElements) : undefined;
	}

	undo(): void {
		EditorCore.getInstance().timeline.updateTracks(this.before);
	}
}
