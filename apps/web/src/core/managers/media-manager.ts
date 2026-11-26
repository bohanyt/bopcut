import { localizeErrorDetail } from "@/i18n/error-details";
import { getBrowserTranslator } from "@/i18n/browser";
import { releaseMediaAssetUrls } from "@/media/url-release";
import { generateImageThumbnail, processMediaFile } from "@/media/processing";
import { readVideoThumbnail } from "@/media/mediabunny";
import { isModelFile } from "@/media/media-utils";
import { thumbnailActivity } from "@/media/thumbnail-activity";
import { ThumbnailQueue } from "@/media/thumbnail-queue";
import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset, MediaLoadFailure, MediaType } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { parseMediaThumbnailReference } from "@/services/storage/media-thumbnail-reference";
import { generateUUID } from "@/utils/id";
import { waveformCache } from "@/services/waveform-cache/service";
import { BatchCommand, RemoveMediaAssetCommand } from "@/commands";

/** Media ids used by elements anywhere in these scenes. */
export function mediaIdsInScenes(scenes: readonly { tracks: { main: { elements: readonly unknown[] }; overlay: readonly { elements: readonly unknown[] }[]; audio: readonly { elements: readonly unknown[] }[] } }[]): Set<string> {
	const ids = new Set<string>();
	for (const scene of scenes) {
		for (const track of [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio]) {
			for (const element of track.elements as { mediaId?: unknown }[]) if (typeof element.mediaId === "string") ids.add(element.mediaId);
		}
	}
	return ids;
}

/** Outcome of discarding staged imports: ids removed from storage, and those that could not be. */
export type DiscardResult = { removed: string[]; failed: { id: string; error: string }[] };
export type MediaImportSession = { projectId: string; signal: AbortSignal };

type MediaRetry = {
	original: MediaAsset | undefined;
	read: Promise<{ asset: MediaAsset } | { failure: MediaLoadFailure }>;
};

type BinWrite = { asset: MediaAsset | null; done: Promise<void>; started?: Promise<void> };

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	/** Bumped by every load and clear: a load that is no longer the latest never writes its result. */
	private loadGeneration = 0;
	private loadController: AbortController | null = null;
	/** Project whose stored media are fully in `assets` (null while loading or after a clear). */
	private loadedProjectId: string | null = null;
	/** Stored media of the loaded project that could not be read (see retryMissingMedia). */
	private missing: MediaLoadFailure[] = [];
	private retries = new Map<string, MediaRetry>();
	/**
	 * Imports saved to storage but not published to `assets` yet (agent drafts before they commit).
	 * Nothing can use them, so discarding them can never break a clip or a history entry.
	 */
	private staged = new Map<string, { projectId: string; asset: MediaAsset | null }>();
	private pendingPublications = new Map<string, { binChanged: boolean }>();
	private binWrites = new Map<string, Map<string, BinWrite>>();
	private loadingBinChanges: { projectId: string; changes: Map<string, MediaAsset | null> } | null = null;
	private listeners = new Set<() => void>();
	private thumbnails?: ThumbnailQueue<MediaAsset>;
	private failedThumbnails = new WeakSet<File>();
	private thumbnailListeners = new Map<string, Set<() => void>>();

	constructor(private editor: EditorCore) {}

	subscribeThumbnail(id: string, listener: () => void): () => void {
		const listeners = this.thumbnailListeners.get(id) ?? new Set();
		listeners.add(listener);
		this.thumbnailListeners.set(id, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.thumbnailListeners.delete(id);
		};
	}

	requestThumbnail(asset: MediaAsset): () => void {
		const session = this.startImport();
		if (this.editor.renderOnly || !session || asset.thumbnailUrl || this.failedThumbnails.has(asset.file) ||
			(asset.type !== "video" && (asset.type !== "image" || isModelFile(asset.file)))) return () => {};
		this.thumbnails ??= new ThumbnailQueue(thumbnailActivity(this.editor));
		return this.thumbnails.request(asset, async (jobSignal) => {
			const signal = AbortSignal.any([jobSignal, session.signal]);
			const current = () => this.assets.find(({ id, file }) => id === asset.id && file === asset.file);
			const target = current();
			if (!target || target.thumbnailUrl || this.failedThumbnails.has(asset.file)) return;
			let thumbnail: string | null;
			try {
				signal.throwIfAborted();
				if (asset.type === "video") {
					thumbnail = await readVideoThumbnail(asset.file, signal);
				} else {
					const url = URL.createObjectURL(asset.file);
					try {
						thumbnail = (await generateImageThumbnail({ url, signal })).thumbnailUrl;
					} finally {
						URL.revokeObjectURL(url);
					}
				}
				if (!thumbnail) throw new Error("Thumbnail is unavailable");
			} catch {
				if (!signal.aborted) this.failedThumbnails.add(asset.file);
				return;
			}
			signal.throwIfAborted();
			if (!current() || current()?.thumbnailUrl) return;
			const thumbnailUrl = await storageService.storeMissingMediaThumbnail(session.projectId, asset, thumbnail, signal);
			signal.throwIfAborted();
			const updated = current();
			if (!updated || updated.thumbnailUrl) return;
			// Thumbnail-only notifications avoid recomputing the editor's media and scene snapshots.
			updated.thumbnailUrl = thumbnailUrl;
			this.thumbnailListeners.get(updated.id)?.forEach((listener) => listener());
		});
	}

	startImport(): MediaImportSession | null {
		const { project } = this.editor;
		const projectId = project.getActiveOrNull()?.metadata.id;
		return projectId && project.canImportMedia(projectId) ? { projectId, signal: project.getSessionSignal() } : null;
	}

	private isCurrentImport({ projectId, signal }: MediaImportSession): boolean {
		return !signal.aborted && this.editor.project.getSessionSignal() === signal &&
			this.editor.project.canImportMedia(projectId);
	}

	persistBinChange({ projectId, id, asset, removedAsset, ifMissing = false }: {
		projectId: string;
		id: string;
		asset: MediaAsset | null;
		removedAsset?: MediaAsset;
		/** Upload `asset` only if its bytes are not stored (Undo of a removal whose delete was never sent). */
		ifMissing?: boolean;
	}): Promise<void> {
		this.markBinChanged({ projectId, id, asset });
		let writes = this.binWrites.get(projectId);
		if (!writes) this.binWrites.set(projectId, writes = new Map());
		const projectWrites = writes;
		const reference = parseMediaThumbnailReference((asset ?? removedAsset)?.thumbnailUrl);
		const pending = projectWrites.get(id);
		const previous = pending?.started;
		const started = reference || previous || ifMissing ? Promise.withResolvers<void>() : undefined;
		const send = () => {
			try {
				return asset
					? storageService.saveMediaAsset({
						projectId, mediaAsset: asset,
						...(reference && { onThumbnailStored: (url: string | undefined) => {
							if (asset.thumbnailUrl === url || !this.assets.includes(asset)) return;
							asset.thumbnailUrl = url;
							this.assets = [...this.assets];
							this.notify();
						} }),
					})
					: storageService.deleteMediaAsset({ projectId, id });
			} finally {
				started?.resolve();
			}
		};
		// Capture a projected thumbnail before its metadata disappears. A later history action
		// only waits for the earlier request to be sent, even if its response is delayed.
		const write = (): Promise<void> => {
			if (asset && ifMissing) {
				// Another tab may have removed the bytes meanwhile. Later writes wait for this check, and a
				// later write (a Redo) replaces the upload.
				return storageService.hasStoredMediaAsset({ projectId, id, signal: AbortSignal.timeout(10_000) })
					.catch(() => false)
					.then((stored) => stored || projectWrites.get(id)?.done !== done ? started?.resolve() : send());
			}
			return reference && removedAsset
				? storageService.captureRemovedThumbnail(removedAsset, pending?.asset?.file === removedAsset.file).then(send, send)
				: send();
		};
		const done: Promise<void> = (previous ? previous.then(write) : write()).finally(() => {
			if (projectWrites.get(id)?.done === done) projectWrites.delete(id);
			if (!projectWrites.size && this.binWrites.get(projectId) === projectWrites) this.binWrites.delete(projectId);
		});
		projectWrites.set(id, { asset, done, started: started?.promise });
		return done;
	}

	/**
	 * A bin change of `id` is decided, though its write may follow later: a late import response must not
	 * republish it, and a project media load still running must not bring back the old entry.
	 */
	markBinChanged({ projectId, id, asset }: { projectId: string; id: string; asset: MediaAsset | null }): void {
		const publication = this.pendingPublications.get(id);
		if (publication) publication.binChanged = true;
		if (this.loadingBinChanges?.projectId === projectId) this.loadingBinChanges.changes.set(id, asset);
	}

	async settleBinWrites(projectId: string): Promise<void> {
		await Promise.allSettled([...(this.binWrites.get(projectId)?.values() ?? [])].map(({ done }) => done));
	}

	async importFile({ session, file, name, words, ratchetFps = true, stagedIds }: {
		session: MediaImportSession;
		file: File;
		name?: string;
		words?: MediaAsset["words"];
		ratchetFps?: boolean;
		stagedIds?: string[];
	}): Promise<MediaAsset | null> {
		if (!this.isCurrentImport(session)) return null;
		const { projectId, signal } = session;
		const processed = await processMediaFile({ file, signal });
		if (!processed) return null;
		if (!this.isCurrentImport(session)) {
			releaseMediaAssetUrls(processed);
			return null;
		}
		const asset = { ...processed, name: name ?? processed.name, words };
		if (!stagedIds) return this.addMediaAsset({ projectId, asset, ratchetFps, session });
		const saved = await this.stageMediaAsset({ projectId, asset, onId: (id) => stagedIds.push(id) });
		return this.isCurrentImport(session) ? saved : null;
	}

	/**
	 * `ratchetFps: false` keeps the project frame rate when the media has a higher one (agent
	 * imports: the bundle or the project decides the frame rate, not the footage).
	 */
	async addMediaAsset({
		projectId,
		asset,
		ratchetFps = true,
		session = { projectId, signal: this.editor.project.getSessionSignal() },
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
		ratchetFps?: boolean;
		session?: MediaImportSession;
	}): Promise<MediaAsset | null> {
		if (!this.isCurrentImport(session) || session.projectId !== projectId) {
			releaseMediaAssetUrls(asset);
			return null;
		}
		const newAsset: MediaAsset = { ...asset, id: generateUUID() };
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			releaseMediaAssetUrls(newAsset);
		};
		session.signal.addEventListener("abort", release, { once: true });
		const pending = { binChanged: false };
		this.pendingPublications.set(newAsset.id, pending);

		try {
			await storageService.saveMediaAsset({
				projectId, mediaAsset: newAsset,
				onThumbnailStored: (url) => { newAsset.thumbnailUrl = url; },
			});
			if (!this.isCurrentImport(session)) {
				release();
				if (session.signal.aborted) await this.reconcileLatePublication(projectId, newAsset, pending);
				return null;
			}
		} catch (error) {
			release();
			// A failed response can arrive after another tab has seen the saved asset.
			if (!this.isCurrentImport(session)) return null;
			console.error("Failed to save media asset:", error);
			toast.error(storageService.isQuotaExceededError({ error }) ? getBrowserTranslator()("media.storageFull") : getBrowserTranslator()("media.saveFailed"), {
				description: error instanceof Error ? localizeErrorDetail(error.message, getBrowserTranslator()) : undefined,
			});
			return null;
		} finally {
			this.pendingPublications.delete(newAsset.id);
			session.signal.removeEventListener("abort", release);
		}
		if (pending.binChanged) {
			release();
			return null;
		}
		const loaded = this.assets.find(({ id }) => id === newAsset.id);
		if (loaded) release();
		else this.assets = [...this.assets, newAsset];
		const published = loaded ?? newAsset;
		if (ratchetFps) this.editor.project.ratchetFpsForImportedMedia({ importedAssets: [published] });
		if (!loaded) this.notify();
		return published;
	}

	/** A write accepted before a switch can finish after its project reopens. */
	private async reconcileLatePublication(projectId: string, asset: MediaAsset, pending: { binChanged: boolean }): Promise<void> {
		const session = this.startImport();
		if (session?.projectId !== projectId || pending.binChanged || this.assets.some(({ id }) => id === asset.id)) return;
		const { id } = asset;
		const stored = await storageService.hasStoredMediaAsset({
			projectId, id, signal: AbortSignal.any([session.signal, AbortSignal.timeout(10_000)]),
		}).catch(() => null);
		if (!stored || !this.isCurrentImport(session) || pending.binChanged || this.assets.some((current) => current.id === id)) return;
		this.assets = [...this.assets, {
			...asset,
			url: URL.createObjectURL(asset.file),
			thumbnailUrl: asset.thumbnailUrl?.startsWith("blob:") ? undefined : asset.thumbnailUrl,
		}];
		if (this.missing.some(({ id }) => id === asset.id)) {
			this.missing = this.missing.filter(({ id }) => id !== asset.id);
			toast.dismiss(`missing-media-${projectId}`);
			if (this.missing.length) this.reportMissing({ projectId });
		}
		this.notify();
	}

	/**
	 * Removes an asset no clip uses, without an Undo step: for an import the person abandoned (a
	 * voice-over take saved as a WAV instead). An asset that was put on the timeline meanwhile stays.
	 */
	discardUnusedAsset({ projectId, id }: { projectId: string; id: string }): boolean {
		if (!this.editor.project.canImportMedia(projectId) || !this.getAssets().some((asset) => asset.id === id)) return false;
		if (mediaIdsInScenes(this.editor.scenes.getScenes()).has(id)) return false;
		new RemoveMediaAssetCommand({ projectId, assetId: id }).execute();
		return true;
	}

	removeMediaAsset({ projectId, id }: { projectId: string; id: string }): void {
		this.removeMediaAssets({ projectId, ids: [id] });
	}

	removeMediaAssets({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		if (!this.editor.project.canImportMedia(projectId)) return;
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		const command =
			uniqueIds.length === 1
				? new RemoveMediaAssetCommand({
						projectId,
						assetId: uniqueIds[0],
					})
				: new BatchCommand(
						uniqueIds.map((id) =>
							new RemoveMediaAssetCommand({
								projectId,
								assetId: id,
							}),
						),
					);

		this.editor.command.execute({ command });
	}

	/**
	 * Loads a project's stored media. Assets added while loading (an import, an agent draft) are
	 * kept: the stored list is merged in front of them. A load superseded by a newer load or a clear
	 * (switching projects) is cancelled and never overwrites the newer assets.
	 */
	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		const generation = ++this.loadGeneration;
		this.loadController?.abort();
		const controller = new AbortController();
		this.loadController = controller;
		this.loadedProjectId = null;
		this.missing = [];
		this.isLoading = true;
		const bin = { projectId, changes: new Map<string, MediaAsset | null>() };
		for (const [id, { asset }] of this.binWrites.get(projectId) ?? []) {
			bin.changes.set(id, asset);
		}
		this.loadingBinChanges = bin;
		this.notify();
		const missing: MediaLoadFailure[] = [];

		// Large projects take a while: show progress so the editor does not look frozen.
		const toastId = `load-media-${projectId}`;
		let lastToast = 0;
		try {
			controller.signal.throwIfAborted();
			const usedIds = mediaIdsInScenes(this.editor.scenes.getScenes());
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
				signal: controller.signal,
				usedIds,
				excludeIds: new Set(bin.changes.keys()),
				onProgress: ({ loaded, total }) => {
					// At most ~4 updates a second: re-rendering the toast for every file slows the load itself.
					const now = Date.now();
					if (total < 20 || generation !== this.loadGeneration || (now - lastToast < 250 && loaded < total)) return;
					lastToast = now;
					toast.loading(getBrowserTranslator()("media.loadingProgress", { loaded, total }), { id: toastId });
				},
				onFailed: (failure) => missing.push(failure),
			});
			if (generation !== this.loadGeneration) return;
			const live = new Map(this.assets.map((asset) => [asset.id, asset]));
			const unchanged = mediaAssets.filter(({ id }) => !bin.changes.has(id)).map((asset) => live.get(asset.id) ?? asset);
			for (const [id, asset] of bin.changes) {
				if (asset && !live.has(id)) unchanged.push({ ...asset, url: URL.createObjectURL(asset.file) });
			}
			this.mergeAssets(unchanged);
			this.missing = missing.filter(({ id }) => !bin.changes.has(id) && !live.has(id));
			this.loadedProjectId = projectId;
			if (this.missing.length) this.reportMissing({ projectId });
		} catch (error) {
			if (generation === this.loadGeneration)
				console.error("Failed to load media assets:", error);
		} finally {
			toast.dismiss(toastId);
			if (this.loadingBinChanges === bin) this.loadingBinChanges = null;
			if (generation === this.loadGeneration) {
				this.isLoading = false;
				this.loadController = null;
				this.notify();
			}
		}
	}

	/** A project created empty in this session has all its media loaded. */
	markProjectMediaLoaded({ projectId }: { projectId: string }): void {
		this.loadedProjectId = projectId;
		this.notify();
	}

	/** True once the project's stored media are loaded (and no newer load is running). */
	isProjectMediaLoaded({ projectId }: { projectId: string }): boolean {
		return !this.isLoading && this.loadedProjectId === projectId;
	}

	/** Stored media of the loaded project that could not be read; empty when all loaded. */
	getMissingMedia(): MediaLoadFailure[] {
		return this.missing;
	}

	getMissingReferences(references: { id: string; name: string; requiresUrl?: boolean; types: readonly MediaType[] }[]): MediaLoadFailure[] {
		const byId = new Map(this.assets.map((asset) => [asset.id, asset]));
		const failures = new Map(this.missing.map((failure) => [failure.id, failure]));
		const missing = new Map<string, MediaLoadFailure>();
		for (const { id, name, requiresUrl, types } of references) {
			const asset = byId.get(id);
			if (asset && !types.includes(asset.type)) {
				missing.set(id, { id, name, error: "Media type does not match the timeline reference", unreadable: true });
				continue;
			}
			if (asset?.file && (!requiresUrl || asset.url)) continue;
			missing.set(id, failures.get(id) ?? { id, name, error: "Media file is unavailable" });
		}
		return [...missing.values()];
	}

	/** Reads the missing media again; returns the ones still missing. */
	async retryMissingMedia({ projectId, failures = this.missing }: { projectId: string; failures?: MediaLoadFailure[] }): Promise<MediaLoadFailure[]> {
		const { project } = this.editor;
		if (project.getActiveOrNull()?.metadata.id !== projectId || this.isLoading || failures.length === 0) return this.missing;
		const generation = this.loadGeneration;
		const session = project.getSession();
		const isCurrent = () => generation === this.loadGeneration && session === project.getSession();
		const byId = new Map(this.assets.map((asset) => [asset.id, asset]));
		const pending = new Map<string, MediaRetry>();
		for (const failure of failures) {
			// Export retries library audio through the mixer, with a fresh fetch.
			if (failure.sourceUrl !== undefined) continue;
			const original = byId.get(failure.id);
			if (!failure.unreadable && original?.file && (original.type === "audio" || original.url)) continue;
			const key = `${generation}:${session}:${failure.id}`;
			let read = this.retries.get(key);
			if (!read) {
				read = { original, read: this.readRetry(projectId, failure) };
				this.retries.set(key, read);
			}
			pending.set(key, read);
		}
		if (!pending.size) return this.missing;
		const results = await Promise.all([...pending].map(async ([key, retry]) => ({
			key, retry, result: await retry.read,
		})));
		// An overlapping batch may already have applied a shared read.
		const uncommitted = results.filter(({ key, retry }) => {
			if (this.retries.get(key) !== retry) return false;
			this.retries.delete(key);
			return true;
		});
		if (!isCurrent() || !uncommitted.length) return this.missing;
		const current = new Map(this.assets.map((asset) => [asset.id, asset]));
		const applied = new Set<string>();
		const restored: MediaAsset[] = [];
		const failed: MediaLoadFailure[] = [];
		for (const { retry, result } of uncommitted) {
			const id = "asset" in result ? result.asset.id : result.failure.id;
			if (current.get(id) !== retry.original) continue;
			applied.add(id);
			if ("asset" in result) {
				restored.push(result.asset);
			} else {
				failed.push(result.failure);
			}
		}
		if (applied.size === 0) return this.missing;
		this.mergeAssets(restored);
		this.missing = [...this.missing.filter(({ id }) => !applied.has(id)), ...failed];
		toast.dismiss(`missing-media-${projectId}`);
		if (this.missing.length) this.reportMissing({ projectId });
		this.notify();
		return this.missing;
	}

	private async readRetry(projectId: string, failure: MediaLoadFailure): MediaRetry["read"] {
		try {
			const asset = await storageService.loadMediaAsset({ projectId, id: failure.id });
			return asset ? { asset } : { failure: { ...failure, error: "not in storage" } };
		} catch (error) {
			return { failure: { ...failure, error: error instanceof Error ? error.message : String(error) } };
		}
	}

	private reportMissing({ projectId }: { projectId: string }): void {
		const count = this.missing.length;
		toast.error(count === 1 ? getBrowserTranslator()("media.loadOneFailed") : getBrowserTranslator()("media.loadManyFailed", { count }), {
			id: `missing-media-${projectId}`,
			description: this.missing.slice(0, 3).map((m) => m.name).join(", ") + (count > 3 ? ", …" : ""),
			duration: Number.POSITIVE_INFINITY,
			action: { label: "Retry", onClick: () => void this.retryMissingMedia({ projectId }) },
		});
	}

	/** Adds assets in front of the current ones; an id already present is replaced, not duplicated. */
	private mergeAssets(assets: MediaAsset[]): void {
		if (assets.length === 0) return;
		const incoming = new Set(assets.map((asset) => asset.id));
		this.assets = [...assets, ...this.assets.filter((asset) => !incoming.has(asset.id))];
	}

	/**
	 * Saves an import to storage without publishing it: it is not in `assets`, so no human edit,
	 * other draft, or history entry can use it until publishStagedMediaAssets. `onId` gets the id
	 * before anything is written, so the caller can always clean up. When saving fails, the partial
	 * file and metadata are removed; if that cleanup fails too, the asset stays staged for
	 * discardStagedMediaAssets to retry, and the error says so.
	 */
	async stageMediaAsset({ projectId, asset, onId }: { projectId: string; asset: Omit<MediaAsset, "id">; onId?: (id: string) => void }): Promise<MediaAsset> {
		const staged: MediaAsset = { ...asset, id: generateUUID() };
		this.staged.set(staged.id, { projectId, asset: staged });
		onId?.(staged.id);
		try {
			await storageService.saveMediaAsset({
				projectId, mediaAsset: staged, staged: true,
				onThumbnailStored: (url) => { staged.thumbnailUrl = url; },
			});
			return staged;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.releaseStagedUrls(this.staged.get(staged.id));
			try {
				await storageService.deleteMediaAsset({ projectId, id: staged.id });
				this.staged.delete(staged.id);
			} catch (cleanup) {
				throw new Error(`${message} (partial file not removed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)})`);
			}
			throw error;
		}
	}

	/** Publishes staged imports (the draft that imported them committed). */
	publishStagedMediaAssets({ ids }: { ids: string[] }): void {
		const assets = ids.flatMap((id) => {
			const entry = this.staged.get(id);
			this.staged.delete(id);
			if (!entry?.asset) return [];
			return [entry.asset];
		});
		if (assets.length === 0) return;
		const incoming = new Set(assets.map((asset) => asset.id));
		this.assets = [...this.assets.filter((asset) => !incoming.has(asset.id)), ...assets];
		this.notify();
	}

	/**
	 * Clears the staged mark on disk of published imports. Until it lands, a load still includes them
	 * when the saved timeline uses them, so a failure here loses nothing.
	 */
	async promotePublishedMediaAssets({ projectId, ids }: { projectId: string; ids: string[] }): Promise<string | null> {
		try {
			await storageService.promoteMediaAssets({ projectId, ids });
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * Takes just-published imports back to staged, for a commit that threw in the same task as
	 * publishStagedMediaAssets (so nothing can have used them yet).
	 */
	unpublishMediaAssets({ projectId, ids }: { projectId: string; ids: string[] }): void {
		const back = new Set(ids);
		if (back.size === 0) return;
		for (const asset of this.assets) {
			if (!back.has(asset.id)) continue;
			this.staged.set(asset.id, { projectId, asset });
		}
		this.assets = this.assets.filter((asset) => !back.has(asset.id));
		this.notify();
	}

	/**
	 * Deletes staged (never published) imports from storage. Published or unknown ids are never
	 * deleted here: they are reported as failed and left alone.
	 */
	async discardStagedMediaAssets({ ids }: { ids: string[] }): Promise<DiscardResult> {
		const result: DiscardResult = { removed: [], failed: [] };
		await Promise.all([...new Set(ids)].map(async (id) => {
			const entry = this.staged.get(id);
			if (!entry) {
				if (this.assets.some((asset) => asset.id === id)) result.failed.push({ id, error: "published; kept" });
				else result.removed.push(id); // already cleaned up when its save failed
				return;
			}
			this.releaseStagedUrls(entry);
			try {
				await storageService.deleteMediaAsset({ projectId: entry.projectId, id });
				this.staged.delete(id);
				result.removed.push(id);
			} catch (error) {
				result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
			}
		}));
		return result;
	}

	private releaseStagedUrls(entry: { asset: MediaAsset | null } | undefined): void {
		if (!entry?.asset) return;
		releaseMediaAssetUrls(entry.asset);
		entry.asset = null;
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		waveformCache.clearAll();

		this.assets.forEach(releaseMediaAssetUrls);

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		this.thumbnails?.clear();
		this.failedThumbnails = new WeakSet<File>();
		this.loadGeneration++;
		this.loadController?.abort();
		this.loadController = null;
		this.loadingBinChanges = null;
		this.loadedProjectId = null;
		this.missing = [];
		this.isLoading = false;
		waveformCache.clearAll();

		this.assets.forEach(releaseMediaAssetUrls);
		for (const entry of this.staged.values()) this.releaseStagedUrls(entry);

		this.assets = [];
		this.notify();
	}

	/** Sets the spoken words of a project media file in the editor (stored by storageService.setMediaWords). */
	setMediaWords({ id, words }: { id: string; words: import("@/media/words").SourceWord[] | undefined }): void {
		if (!this.assets.some((asset) => asset.id === id)) return;
		this.assets = this.assets.map((asset) => (asset.id === id ? { ...asset, words } : asset));
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
