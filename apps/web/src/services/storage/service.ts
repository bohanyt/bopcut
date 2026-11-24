import { getBrowserTranslator } from "@/i18n/browser";
import type { TProject, TProjectMetadata } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { MediaAsset, MediaLoadFailure } from "@/media/types";
import { normalizeBookmarkBox } from "@/timeline/bookmarks/area";
import { recordMediaFileVersion } from "./media-file-version";
import { parseMediaThumbnailReference } from "./media-thumbnail-reference";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import { DiskAdapter, DiskSoundsAdapter } from "./disk-adapter";
import { toast } from "sonner";
import { parseSourceWords } from "@/media/words";
import { getProjectId } from "./migrations/transformers/utils";
import type { ProjectRecord } from "./migrations/transformers/types";
import { type StorageCapacityCheckResult, isStorageQuotaExceededError } from "./quota";
import type {
	MediaAssetData,
	StorageConfig,
	SerializedProject,
	SerializedScene,
	ProjectNavigation,
	ProjectSummary,
} from "./types";
import type { SavedSoundsData, SavedSound, SoundEffect } from "@/sounds/types";
import { CURRENT_PROJECT_VERSION, migrations } from "@/services/storage/migrations";
import type { Bookmark, SceneTracks } from "@/timeline";
import { roundMediaTime, TICKS_PER_SECOND } from "@/wasm";

const browserMigrationKey = "bopencut:browser-storage-copied";

async function migrateProject(project: ProjectRecord, id: string, version: number) {
	for (const migration of migrations) {
		if (migration.from !== version) continue;
		const result = await migration.run({ projectId: id, project });
		if (result.skipped) throw new Error(`Project migration ${id}: ${result.reason ?? "failed"}`);
		project = result.project;
		version = migration.to;
	}
	return project as unknown as SerializedProject;
}

function deserializeMetadata(metadata: ProjectSummary["metadata"], duration = metadata.duration): TProjectMetadata {
	return {
		...metadata,
		duration: roundMediaTime({ time: duration ?? 0 }),
		createdAt: new Date(metadata.createdAt),
		updatedAt: new Date(metadata.updatedAt),
	};
}

function deserializeSummary({ metadata, version }: ProjectSummary): TProjectMetadata {
	const duration = metadata.duration ?? 0;
	// Before version 23 metadata used seconds. Listing must work before that project is opened.
	return deserializeMetadata(metadata, version < 23 ? duration * TICKS_PER_SECOND : duration);
}

export function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			const box = normalizeBookmarkBox(obj.box);
			return {
				time: roundMediaTime({ time: obj.time }),
				...(box && { box }),
				...(typeof obj.id === "string" && { id: obj.id }),
				...((obj.author === "user" || obj.author === "agent") && { author: obj.author }),
				...(typeof obj.resolved === "boolean" && { resolved: obj.resolved }),
				...(typeof obj.createdAt === "string" && { createdAt: obj.createdAt }),
				...(Array.isArray(obj.replies) && { replies: obj.replies.filter((r): r is NonNullable<Bookmark["replies"]>[number] => !!r && typeof r.id === "string" && typeof r.text === "string" && (r.author === "user" || r.author === "agent") && typeof r.createdAt === "string") }),
				...(Array.isArray(obj.elementIds) && { elementIds: obj.elementIds.filter((id): id is string => typeof id === "string") }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((b): b is Bookmark => b !== null);
}

class StorageService {
	private projectsAdapter = new DiskAdapter();
	private savedSoundsAdapter = new DiskSoundsAdapter<SavedSoundsData>();
	private config: StorageConfig;
	private migrationsPromise: Promise<void> | null = null;
	/**
	 * Media metadata lists by project, kept from the last full load and updated by this service's
	 * own saves and deletes, so reading one asset does not refetch the whole list (it can be tens of
	 * MB with thumbnails).
	 */
	private manifests = new Map<string, Map<string, MediaAssetData>>();
	private removedThumbnails = new WeakMap<File, Map<string, string | undefined>>();
	/** Manifests kept at once (the open project and the one before it); older ones are dropped. */
	private static readonly MANIFEST_LIMIT = 2;

	constructor() {
		this.config = {
			projectsDb: "video-editor-projects",
			mediaDb: "video-editor-media",
			savedSoundsDb: "video-editor-saved-sounds",
			version: 1,
		};
	}

	async ensureMigrations(): Promise<void> {
		this.migrationsPromise ??= this.migrateBrowserProjects();
		await this.migrationsPromise;
	}

	private async migrateBrowserProjects(): Promise<void> {
		if (typeof indexedDB === "undefined") return;
		try {
			if (localStorage.getItem(browserMigrationKey) === "1") return;
		} catch {
			// Storage can be unavailable in some browser contexts. The disk markers still prevent copies.
		}
		const legacy = new IndexedDBAdapter<ProjectRecord>({ dbName: this.config.projectsDb, storeName: "projects", version: 1 });
		let copied = 0, failed = 0;
		try {
			for (const source of await legacy.getAll({ existingOnly: true })) {
				const id = getProjectId({ project: source });
				if (!id) { failed++; continue; }
				try {
					if (await this.projectsAdapter.migrationExists(id)) continue;
					const version = typeof source.version === "number" ? source.version : (Array.isArray(source.scenes) && source.scenes.length ? 1 : 0);
					const project = await migrateProject(source, id, version);
					const { mediaMetadataAdapter, mediaAssetsAdapter } = this.getProjectMediaAdapters({ projectId: id });
					for (const metadata of await mediaMetadataAdapter.getAll({ existingOnly: true })) {
						const file = await mediaAssetsAdapter.get(metadata.id);
						if (!file) throw new Error(`Media ${metadata.id} not found`);
						await this.projectsAdapter.saveMedia(id, { ...metadata, fileName: metadata.fileName ?? file.name, fileType: metadata.fileType ?? file.type }, file);
					}
					if (await this.projectsAdapter.migrate(project)) copied++;
				} catch (error) { failed++; console.error("Project migration failed:", id, error); }
			}
		} catch (error) { failed++; console.error("Browser migration failed:", error); }
		let soundsFailed = false;
		try {
			const sounds = new IndexedDBAdapter<SavedSoundsData>({ dbName: this.config.savedSoundsDb, storeName: "saved-sounds", version: 1 });
			const data = await sounds.get("user-sounds", { existingOnly: true });
			if (data) await this.savedSoundsAdapter.migrate(data);
		} catch (error) {
			soundsFailed = true;
			console.error("Sound migration failed:", error);
			toast.error(getBrowserTranslator()("storage.soundCopyFailed"));
		}

		if (copied) toast.success(getBrowserTranslator()("storage.projectsCopied", { count: copied }));
		if (failed) toast.error(getBrowserTranslator()("storage.projectsCopyFailed", { count: failed }));
		if (!failed && !soundsFailed) {
			try {
				localStorage.setItem(browserMigrationKey, "1");
			} catch {
				// The next page load can still check the disk markers.
			}
		}
	}

	private getProjectMediaAdapters({ projectId }: { projectId: string }) {
		const mediaMetadataAdapter = new IndexedDBAdapter<MediaAssetData>({
			dbName: `${this.config.mediaDb}-${projectId}`,
			storeName: "media-metadata",
			version: this.config.version,
		});

		const mediaAssetsAdapter = new OPFSAdapter(`media-files-${projectId}`);

		return { mediaMetadataAdapter, mediaAssetsAdapter };
	}

	async canStoreFile({
		size,
	}: {
		size: number;
	}): Promise<StorageCapacityCheckResult> {
		return { canStore: true, reason: "estimate-unavailable", availableBytes: null };
	}

	isQuotaExceededError({ error }: { error: unknown }): boolean {
		return isStorageQuotaExceededError({ error });
	}

	private stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
		return {
			...tracks,
			audio: tracks.audio.map((track) => ({
				...track,
				elements: track.elements.map((element) => {
					if (element.type !== "audio") return element;
					const { buffer: _buffer, ...rest } = element;
					return rest;
				}),
			})),
		};
	}

	async saveProject({ project, includeView = false }: { project: TProject; includeView?: boolean }): Promise<void> {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromScenes({ scenes: project.scenes });
		const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			...(scene.kind && { kind: scene.kind }),
			...(scene.compoundOrigin && { compoundOrigin: scene.compoundOrigin }),
			tracks: this.stripAudioBuffers({ tracks: scene.tracks }),
			bookmarks: scene.bookmarks,
			createdAt: scene.createdAt.toISOString(),
			updatedAt: scene.updatedAt.toISOString(),
		}));

		const serializedProject: SerializedProject = {
			metadata: {
				id: project.metadata.id,
				name: project.metadata.name,
				thumbnail: project.metadata.thumbnail,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			scenes: serializedScenes,
			currentSceneId: project.currentSceneId,
			settings: project.settings,
			version: project.version,
			...(includeView && { timelineViewState: project.timelineViewState }),
		};

		await this.projectsAdapter.set({
			key: project.metadata.id,
			value: serializedProject,
		});
	}

	async saveProjectNavigation({ id, navigation }: { id: string; navigation: ProjectNavigation }): Promise<void> {
		await this.projectsAdapter.saveNavigation(id, navigation);
	}

	async saveProjectThumbnail({ id, thumbnail }: { id: string; thumbnail: Blob }): Promise<string> {
		return this.projectsAdapter.saveThumbnail(id, thumbnail);
	}

	/**
	 * Renames a stored project on the copy that is on disk when it is written (a write in between is
	 * re-read, not overwritten). The new metadata, or null when the project does not exist.
	 */
	async renameProject({ id, name }: { id: string; name: string }): Promise<TProjectMetadata | null> {
		const updated = await this.projectsAdapter.update(id, (stored) => ({
			...stored,
			metadata: { ...stored.metadata, name, updatedAt: new Date().toISOString() },
		}));
		if (!updated) return null;
		return deserializeSummary(updated);
	}

	async loadProject({
		id,
		readOnly = false,
	}: {
		id: string;
		readOnly?: boolean;
	}): Promise<{ project: TProject } | null> {
		if (!readOnly) await this.ensureMigrations();
		let serializedProject = await this.projectsAdapter.get(id);
		if (serializedProject && typeof serializedProject.version === "number" && serializedProject.version < CURRENT_PROJECT_VERSION) {
			if (readOnly) throw new Error("This project needs migration. Open it in the editor once and retry.");
			// Transform the exact copy whose revision is checked by the write. On a conflict, retry
			// against the latest copy, which may already have been migrated in another tab.
			serializedProject = await this.projectsAdapter.update(id, (current) =>
				current.version < CURRENT_PROJECT_VERSION
					? migrateProject(current as unknown as ProjectRecord, id, current.version)
					: current,
			);
		}

		if (!serializedProject) return null;

		if (
			typeof serializedProject !== "object" ||
			serializedProject === null ||
			typeof serializedProject.metadata !== "object" ||
			serializedProject.metadata === null
		) {
			console.warn(
				"[storage] Skipping malformed project entry (missing metadata):",
				{ id, entry: serializedProject },
			);
			return null;
		}

		const scenes =
			serializedProject.scenes?.map((scene) => ({
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				...(scene.kind && { kind: scene.kind }),
				...(scene.compoundOrigin && { compoundOrigin: scene.compoundOrigin }),
				tracks: scene.tracks,
				bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
				createdAt: new Date(scene.createdAt),
				updatedAt: new Date(scene.updatedAt),
			})) ?? [];

		const { metadata, navigation } = serializedProject;
		const validNavigation = navigation && scenes.some((scene) => scene.id === navigation.currentSceneId);
		const project: TProject = {
			metadata: deserializeMetadata(metadata, metadata.duration ?? getProjectDurationFromScenes({ scenes })),
			scenes,
			currentSceneId: validNavigation ? navigation.currentSceneId : serializedProject.currentSceneId || "",
			settings: serializedProject.settings,
			version: serializedProject.version,
			timelineViewState: validNavigation ? navigation.timelineViewState : serializedProject.timelineViewState,
		};

		return { project };
	}

	async loadAllProjects(): Promise<TProject[]> {
		await this.ensureMigrations();
		const projectIds = await this.projectsAdapter.list();
		const projects: TProject[] = [];

		for (const id of projectIds) {
			const result = await this.loadProject({ id });
			if (result?.project) {
				projects.push(result.project);
			}
		}

		return projects.sort(
			(a, b) => b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
		);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		await this.ensureMigrations();
		const summaries = await this.projectsAdapter.summaries();
		return summaries.map(deserializeSummary)
			.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await this.projectsAdapter.remove(id);
		this.forgetMediaManifest({ projectId: id });
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
		staged = false,
		onThumbnailStored,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
		/** Saved for a draft that has not committed: hidden from loads until promoteMediaAssets. */
		staged?: boolean;
		onThumbnailStored?: (url: string | undefined) => void;
	}): Promise<void> {

		let thumbnailUrl = mediaAsset.thumbnailUrl;
		const reference = parseMediaThumbnailReference(thumbnailUrl);
		if (reference && thumbnailUrl) {
			if (reference.projectId !== projectId || reference.mediaId !== mediaAsset.id) {
				thumbnailUrl = await copyThumbnail(reference);
			} else {
				const removed = this.removedThumbnails.get(mediaAsset.file);
				if (removed?.has(thumbnailUrl)) thumbnailUrl = removed.get(thumbnailUrl);
			}
		}
		const metadata: MediaAssetData = {
			id: mediaAsset.id,
			name: mediaAsset.name,
			fileName: mediaAsset.file.name,
			fileType: mediaAsset.file.type,
			type: mediaAsset.type,
			size: mediaAsset.file.size,
			lastModified: mediaAsset.file.lastModified,
			width: mediaAsset.width,
			height: mediaAsset.height,
			duration: mediaAsset.duration,
			fps: mediaAsset.fps,
			...(mediaAsset.hasVariableGifDelay && { hasVariableGifDelay: true }),
			hasAudio: mediaAsset.hasAudio,
			thumbnailUrl,
			ephemeral: mediaAsset.ephemeral,
			...(mediaAsset.words ? { words: mediaAsset.words } : {}),
			...(staged ? { staged: true } : {}),
		};

		metadata.thumbnailUrl = await this.projectsAdapter.saveMedia(projectId, metadata, mediaAsset.file);
		this.manifests.get(projectId)?.set(metadata.id, metadata);
		onThumbnailStored?.(metadata.thumbnailUrl);
	}

	/** Sets (or replaces) the spoken words stored with a media file. */
	async setMediaWords({ projectId, id, words }: { projectId: string; id: string; words: import("@/media/words").SourceWord[] | undefined }): Promise<void> {
		const manifest = this.manifests.get(projectId) ?? (await this.fetchManifest({ projectId }));
		const metadata = manifest.get(id);
		if (!metadata) throw new Error(`Media ${id} is not stored`);
		const { words: _old, ...rest } = metadata;
		const updated = words ? { ...rest, words } : rest;
		await this.projectsAdapter.updateMediaMetadata(projectId, updated);
		manifest.set(id, updated);
	}

	/** Clears the staged mark of media whose draft committed, so every later load includes them. */
	async promoteMediaAssets({ projectId, ids }: { projectId: string; ids: string[] }): Promise<void> {
		if (ids.length === 0) return;
		const manifest = this.manifests.get(projectId) ?? (await this.fetchManifest({ projectId }));
		for (const id of ids) {
			const metadata = manifest.get(id);
			if (!metadata?.staged) continue;
			const { staged: _staged, ...promoted } = metadata;
			await this.projectsAdapter.updateMediaMetadata(projectId, promoted);
			manifest.set(id, promoted);
		}
	}

	hasStoredMediaAsset({ projectId, id, signal }: { projectId: string; id: string; signal: AbortSignal }): Promise<boolean> {
		return this.projectsAdapter.hasStoredMediaAsset(projectId, id, signal);
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const metadata = this.manifests.get(projectId)?.get(id) ?? (await this.fetchManifest({ projectId })).get(id);
		if (!metadata) return null;
		return this.readMediaAsset({ projectId, metadata });
	}

	private async fetchManifest({ projectId }: { projectId: string }): Promise<Map<string, MediaAssetData>> {
		const manifest = new Map((await this.projectsAdapter.mediaList(projectId)).map((item) => [item.id, item] as const));
		this.manifests.delete(projectId);
		this.manifests.set(projectId, manifest);
		for (const id of this.manifests.keys()) {
			if (this.manifests.size <= StorageService.MANIFEST_LIMIT) break;
			this.manifests.delete(id);
		}
		return manifest;
	}

	/** Drops the cached media list of a project (closed or deleted). */
	forgetMediaManifest({ projectId }: { projectId: string }): void {
		this.manifests.delete(projectId);
	}

	private async readMediaAsset({
		projectId,
		metadata,
		signal,
	}: {
		projectId: string;
		metadata: MediaAssetData;
		signal?: AbortSignal;
	}): Promise<MediaAsset> {
		const id = metadata.id;
		const url = this.projectsAdapter.mediaUrl(projectId, id);
		const response = await fetch(url, { signal });
		if (!response.ok) throw new Error(`Media ${id} cannot be read`);
		const blob = await response.blob();
		const file = new File([blob], metadata.fileName ?? metadata.name, { type: metadata.fileType ?? blob.type, lastModified: metadata.lastModified });
		recordMediaFileVersion(file, response.headers.get("X-Media-Revision"));

		return {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			file,
			url,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			fps: metadata.fps,
			...(metadata.hasVariableGifDelay && { hasVariableGifDelay: true }),
			hasAudio: metadata.hasAudio,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
			...(metadata.words ? { words: parseSourceWords(metadata.words) ?? undefined } : {}),
		};
	}

	/**
	 * Loads every media asset: the metadata list is fetched once (and cached) and files are read with
	 * bounded concurrency. Aborting `signal` stops starting new reads and rejects. A file that cannot
	 * be read is left out and reported through `onFailed`.
	 */
	async loadAllMediaAssets({
		projectId,
		concurrency = 8,
		onProgress,
		onFailed,
		signal,
		usedIds,
		excludeIds,
	}: {
		projectId: string;
		concurrency?: number;
		onProgress?: (progress: { loaded: number; total: number }) => void;
		onFailed?: (failure: MediaLoadFailure) => void;
		signal?: AbortSignal;
		/** Media the project's timeline uses: staged media are loaded only when listed here. */
		usedIds?: ReadonlySet<string>;
		excludeIds?: ReadonlySet<string>;
	}): Promise<MediaAsset[]> {
		// Staged media belong to a draft still loading (maybe in another tab): skipped unless the
		// saved timeline already uses them (the draft committed but its promotion did not finish).
		const list = [...(await this.fetchManifest({ projectId })).values()].filter((metadata) => !excludeIds?.has(metadata.id) && (!metadata.staged || usedIds?.has(metadata.id)));
		const items: (MediaAsset | null)[] = new Array(list.length).fill(null);
		let next = 0;
		let loaded = 0;
		const worker = async () => {
			while (next < list.length) {
				signal?.throwIfAborted();
				const index = next++;
				const metadata = list[index];
				try {
					items[index] = await this.readMediaAsset({ projectId, metadata, signal });
				} catch (error) {
					if (signal?.aborted) throw error;
					console.error(`Failed to load media ${metadata.id}:`, error);
					onFailed?.({
						id: metadata.id,
						name: metadata.name,
						error: error instanceof Error ? error.message : String(error),
						...(metadata.type === "video" && metadata.hasAudio !== undefined && { hasAudio: metadata.hasAudio }),
					});
				}
				loaded++;
				onProgress?.({ loaded, total: list.length });
			}
		};
		await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), list.length) }, worker));
		signal?.throwIfAborted();
		return items.filter((item): item is MediaAsset => item !== null);
	}

	async captureRemovedThumbnail(asset: MediaAsset, restoring = false): Promise<void> {
		const url = asset.thumbnailUrl;
		const reference = parseMediaThumbnailReference(url);
		if (!url || !reference) return;
		const thumbnail = await copyThumbnail(reference);
		let removed = this.removedThumbnails.get(asset.file);
		// A redo can reach disk after the file PUT but before the restoring metadata POST.
		if (restoring && thumbnail === undefined && removed?.has(url)) return;
		if (!removed) this.removedThumbnails.set(asset.file, removed = new Map());
		removed.set(url, thumbnail);
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		await this.projectsAdapter.removeMedia(projectId, id);
		this.manifests.get(projectId)?.delete(id);
	}

	async deleteProjectMedia({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		await this.projectsAdapter.removeProjectMedia(projectId);
		this.manifests.delete(projectId);
	}

	async clearAllData(): Promise<void> {
		await this.projectsAdapter.clear();
		// project-specific media and timelines cleaned up when projects are deleted
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projectIds = await this.projectsAdapter.list();

		return {
			projects: projectIds.length,
			isOPFSSupported: this.isOPFSSupported(),
			isIndexedDBSupported: this.isIndexedDBSupported(),
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const mediaIds = await this.projectsAdapter.mediaList(projectId);

		return {
			mediaItems: mediaIds.length,
		};
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		try {
			const savedSoundsData = await this.savedSoundsAdapter.get("user-sounds");
			return (
				savedSoundsData || {
					sounds: [],
					lastModified: new Date().toISOString(),
				}
			);
		} catch (error) {
			console.error("Failed to load saved sounds:", error);
			return { sounds: [], lastModified: new Date().toISOString() };
		}
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			if (currentData.sounds.some((sound) => sound.id === soundEffect.id)) {
				return; // Already saved
			}

			const savedSound: SavedSound = {
				id: soundEffect.id,
				name: soundEffect.name,
				username: soundEffect.username,
				previewUrl: soundEffect.previewUrl,
				downloadUrl: soundEffect.downloadUrl,
				duration: soundEffect.duration,
				tags: soundEffect.tags,
				license: soundEffect.license,
				savedAt: new Date().toISOString(),
			};

			const updatedData: SavedSoundsData = {
				sounds: [...currentData.sounds, savedSound],
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to save sound effect:", error);
			throw error;
		}
	}

	async removeSavedSound({ soundId }: { soundId: number }): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			const updatedData: SavedSoundsData = {
				sounds: currentData.sounds.filter((sound) => sound.id !== soundId),
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to remove saved sound:", error);
			throw error;
		}
	}

	async isSoundSaved({ soundId }: { soundId: number }): Promise<boolean> {
		try {
			const currentData = await this.loadSavedSounds();
			return currentData.sounds.some((sound) => sound.id === soundId);
		} catch (error) {
			console.error("Failed to check if sound is saved:", error);
			return false;
		}
	}

	async clearSavedSounds(): Promise<void> {
		try {
			await this.savedSoundsAdapter.remove("user-sounds");
		} catch (error) {
			console.error("Failed to clear saved sounds:", error);
			throw error;
		}
	}

	isOPFSSupported(): boolean {
		return OPFSAdapter.isSupported();
	}

	isIndexedDBSupported(): boolean {
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return typeof fetch !== "undefined";
	}
}

export const storageService = new StorageService();
export { StorageService };

async function copyThumbnail({ projectId, mediaId }: { projectId: string; mediaId: string }): Promise<string | undefined> {
	try {
		const url = `/api/storage/projects/${projectId}/media/${mediaId}/thumbnail`;
		const response = await fetch(url, { headers: { Accept: "text/plain" }, signal: AbortSignal.timeout(2_000) });
		if (!response.ok) return;
		const thumbnail = await response.text();
		return /^data:image\//i.test(thumbnail) ? thumbnail : undefined;
	} catch {
		// The copied media file is still usable if its thumbnail cannot be fetched.
	}
}
