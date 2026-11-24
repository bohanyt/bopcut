import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks } from "@/timeline";
import { applyElementUpdates, type ElementUpdate } from "@/timeline/update-pipeline";
import { generateUUID } from "@/utils/id";

export class UpdateElementsCommand extends Command {
	private savedState: SceneTracks | null = null;
	private readonly boundaryIdPrefix = generateUUID();
	private readonly updates: readonly ElementUpdate[];

	constructor({
		updates,
	}: {
		updates: readonly ElementUpdate[];
	}) {
		super();
		this.updates = updates;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		editor.timeline.updateTracks(applyElementUpdates({
			tracks: this.savedState,
			updates: this.updates,
			boundaryIdPrefix: this.boundaryIdPrefix,
		}));
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
