import { Command } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { mediaIdsInScenes } from "@/core/managers/media-manager";
import { RemoveMediaAssetCommand } from "./remove-media-asset";

/** Includes an already saved import in the history entry that inserts its first clip. */
export class AddMediaAssetCommand extends Command {
	override readonly ripples = false;
	private readonly removal: RemoveMediaAssetCommand;
	private removed = false;

	constructor({ projectId, assetId }: { projectId: string; assetId: string }) {
		super();
		this.assetId = assetId;
		this.removal = new RemoveMediaAssetCommand({ projectId, assetId });
	}

	private readonly assetId: string;

	execute(): undefined {
		return undefined;
	}

	undo(): void {
		const editor = EditorCore.getInstance();
		this.removed = editor.media.getAssets().some(({ id }) => id === this.assetId) &&
			!mediaIdsInScenes(editor.scenes.getScenes()).has(this.assetId);
		if (this.removed) this.removal.execute();
	}

	redo(): undefined {
		const editor = EditorCore.getInstance();
		if (this.removed) this.removal.undo();
		const asset = editor.media.getAssets().find(({ id }) => id === this.assetId);
		if (asset) editor.project.ratchetFpsForImportedMedia({ importedAssets: [asset] });
		return undefined;
	}
}
