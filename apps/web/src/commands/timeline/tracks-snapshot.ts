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
		sceneId,
	}: {
		before: SceneTracks;
		after: SceneTracks;
		selectedElements?: ElementRef[];
		ripples?: boolean;
		sceneId?: string;
	}) {
		super();
		this.before = before;
		this.after = after;
		this.selectedElements = selectedElements;
		this.ripples = ripples;
		this.sceneId = sceneId;
	}

	private before: SceneTracks;
	private after: SceneTracks;
	private selectedElements?: ElementRef[];
	private sceneId?: string;

	execute(): CommandResult | undefined {
		const { scenes, timeline } = EditorCore.getInstance();
		if (this.sceneId && scenes.getActiveSceneOrNull()?.id !== this.sceneId) {
			scenes.updateSceneTracks({ sceneId: this.sceneId, tracks: this.after });
			return;
		}
		timeline.updateTracks(this.after);
		return this.selectedElements ? createElementSelectionResult(this.selectedElements) : undefined;
	}

	undo(): void {
		EditorCore.getInstance().timeline.updateTracks(this.before);
	}
}
