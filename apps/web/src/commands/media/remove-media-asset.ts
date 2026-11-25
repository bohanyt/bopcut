import { releaseMediaAssetUrls } from "@/media/url-release";
import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import { mediaIdsInScenes } from "@/core/managers/media-manager";
import type { MediaAsset } from "@/media/types";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { waveformCache } from "@/services/waveform-cache/service";
import { hasMediaId } from "@/timeline/element-utils";
import type { SceneTracks, TScene, TimelineTrack } from "@/timeline";

function withoutMedia<T extends TimelineTrack>(track: T, mediaId: string): T {
	const elements = track.elements.filter(
		(element) => !(hasMediaId(element) && element.mediaId === mediaId),
	);
	return (elements.length === track.elements.length ? track : { ...track, elements }) as T;
}

export class RemoveMediaAssetCommand extends Command {
	private removedIndex = -1;
	/** All scenes before removal: clips using the asset are removed everywhere, compound content included. */
	private savedScenes: TScene[] | null = null;
	private removedAsset: MediaAsset | null = null;
	private pendingRemoval: AbortController | null = null;

	constructor({
		projectId,
		assetId,
	}: {
		projectId: string;
		assetId: string;
	}) {
		super();
		this.projectId = projectId;
		this.assetId = assetId;
	}

	private projectId: string;
	private assetId: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();

		this.removedIndex = assets.findIndex((media) => media.id === this.assetId);
		this.removedAsset = assets[this.removedIndex] ?? null;
		this.savedScenes = null;

		if (!this.removedAsset) {
			console.error("Media asset not found:", this.assetId);
			return;
		}

		releaseMediaAssetUrls(this.removedAsset);

		waveformCache.clearSource({
			sourceKey: buildWaveformSourceKey({
				kind: "media",
				id: this.assetId,
			}),
		});

		editor.media.setAssets({
			assets: assets.filter((media) => media.id !== this.assetId),
		});

		// Remove the clips here rather than through another command, so this stays one history
		// entry and its selection intent is returned below.
		let removedClips = false;
		const previousScenes = editor.scenes.getScenes();
		const nextScenes = previousScenes.map((scene) => {
			const tracks: SceneTracks = {
				overlay: scene.tracks.overlay.map((track) => withoutMedia(track, this.assetId)),
				main: withoutMedia(scene.tracks.main, this.assetId),
				audio: scene.tracks.audio.map((track) => withoutMedia(track, this.assetId)),
			};
			const changed =
				tracks.main !== scene.tracks.main ||
				tracks.overlay.some((track, index) => track !== scene.tracks.overlay[index]) ||
				tracks.audio.some((track, index) => track !== scene.tracks.audio[index]);
			if (!changed) return scene;
			removedClips = true;
			return { ...scene, tracks };
		});
		if (removedClips) {
			this.savedScenes = previousScenes;
			editor.scenes.setScenes({ scenes: nextScenes });
			editor.timeline.updateTracks(editor.scenes.getActiveScene().tracks);
		}

		void this.deleteFromStorage(editor, this.removedAsset, removedClips).catch((error) => {
			console.error("Failed to delete media item:", error);
		});

		return removedClips ? createElementSelectionResult([]) : undefined;
	}

	private async deleteFromStorage(editor: EditorCore, removedAsset: MediaAsset, removedClips: boolean): Promise<void> {
		if (removedClips) {
			const removal = new AbortController();
			this.pendingRemoval = removal;
			// Capture the revision just marked dirty by setScenes. It can save after this project closes.
			const written = await editor.save.getCurrent()?.whenSaved();
			if (removal.signal.aborted) return;
			this.pendingRemoval = null;
			if (!written || mediaIdsInScenes(written.scenes).has(this.assetId)) return;
		}
		await editor.media.persistBinChange({ projectId: this.projectId, id: this.assetId, asset: null, removedAsset });
	}

	undo(): void {
		const editor = EditorCore.getInstance();
		const pending = this.pendingRemoval;
		pending?.abort();
		this.pendingRemoval = null;

		const assets = editor.media.getAssets();
		if (this.removedAsset && !assets.some((asset) => asset.id === this.assetId)) {
			const restoredAsset: MediaAsset = {
				...this.removedAsset,
				url: URL.createObjectURL(this.removedAsset.file),
				thumbnailUrl: this.removedAsset.thumbnailUrl?.startsWith("blob:") ? undefined : this.removedAsset.thumbnailUrl,
			};

			const restoredBin = [...assets];
			restoredBin.splice(this.removedIndex, 0, restoredAsset);
			editor.media.setAssets({ assets: restoredBin });

			if (!pending) {
				editor.media
					.persistBinChange({ projectId: this.projectId, id: this.assetId, asset: restoredAsset })
					.catch((error) => {
						console.error("Failed to restore media item on undo:", error);
					});
			}
		}

		if (this.savedScenes) {
			editor.scenes.setScenes({ scenes: this.savedScenes });
			editor.timeline.updateTracks(editor.scenes.getActiveScene().tracks);
		}
	}
}
