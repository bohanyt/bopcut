import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { applyElementUpdates, type ElementUpdate } from "@/timeline/update-pipeline";
import { patchEditsHumanField, recordHumanTrackEdit } from "@/timeline/human-fields";
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
		const after = applyElementUpdates({
			tracks: this.savedState,
			updates: this.updates,
			boundaryIdPrefix: this.boundaryIdPrefix,
		});
		if (editor.command.isAgent) {
			editor.timeline.updateTracks(after);
		} else {
			const patches = new Map<string, Partial<TimelineElement>[]>();
			for (const { elementId, patch } of this.updates) {
				const previous = patches.get(elementId);
				if (previous) previous.push(patch);
				else patches.set(elementId, [patch]);
			}
			editor.timeline.updateTracks(recordHumanTrackEdit(
				this.savedState, after, undefined,
				(id, field) => patches.get(id)?.some((patch) => patchEditsHumanField(patch, field)) ?? false,
			));
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
