import { localizeErrorDetail } from "@/i18n/error-details";
import { getBrowserTranslator } from "@/i18n/browser";
import type { EditorCore } from "@/core";
import type {
	ProjectMode,
	TProject,
	TProjectMetadata,
	TProjectSortKey,
	TProjectSortOption,
	TProjectSettings,
	TTimelineViewState,
} from "@/project/types";
import type { ExportOptions, ExportResult, ExportState } from "@/export";
import { getExportFailure } from "@/export/failure";
import { storageService } from "@/services/storage/service";
import { toast } from "sonner";
import { generateUUID } from "@/utils/id";
import { UpdateProjectSettingsCommand } from "@/commands/project";
import { previewCanvasSize } from "@/canvas/sizes";
import { buildNewProject } from "@/project/create";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import { buildScene } from "@/services/renderer/scene-builder";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { loadFonts } from "@/fonts/google-fonts";
import { DEFAULTS } from "@/timeline/defaults";
import { getElementFontFamilies } from "@/timeline/element-utils";
import type { TScene } from "@/timeline/types";
import { frameRateToFloat, getRaisedProjectFpsForImportedMedia } from "@/fps/utils";
import type { MediaAsset } from "@/media/types";
import { mediaIdsInScenes } from "./media-manager";

export interface MigrationState {
	isMigrating: boolean;
	fromVersion: number | null;
	toVersion: number | null;
	projectName: string | null;
}

export class ProjectManager {
	private active: TProject | null = null;
	/** Identifies the explicit frame-rate edit currently applied by history. */
	private fpsEditRevision: symbol | undefined;
	private savedProjects: TProjectMetadata[] = [];
	/** Projects hidden from the list. Kept apart from their metadata, which their saves write. */
	private archivedIds: ReadonlySet<string> = new Set();
	private isLoading = true;
	private projectListError: string | null = null;
	/**
	 * Changes whenever another project is opened, created or closed (not when the open project's
	 * settings change), so async work can tell it still runs in the project session it started in.
	 */
	private session = 0;
	private sessionController = new AbortController();
	/** Bumped by every loadProject: a load that is no longer the newest one stops before it installs. */
	private loadSequence = 0;
	/** The load that put the open project in the editor and is still loading its media, or null. */
	private installing: number | null = null;
	/** Projects being deleted, and deleted, in this editor: they do not open. */
	private deleting = new Set<string>();
	private deleted = new Set<string>();
	/** Renames of stored projects still being written: a load of that project waits for them. */
	private renames = new Map<string, Promise<unknown>>();
	private isInitialized = false;
	private invalidProjectIds = new Set<string>();
	private storageMigrationPromise: Promise<void> | null = null;
	private listeners = new Set<() => void>();
	private migrationState: MigrationState = {
		isMigrating: false,
		fromVersion: null,
		toVersion: null,
		projectName: null,
	};
	private exportState: ExportState = {
		isExporting: false,
		progress: 0,
		result: null,
	};
	private exportController: AbortController | null = null;
	private exportTarget: { session: number; sceneId?: string } | null = null;
	private thumbnailGeneration = 0;
	private thumbnailUploads = new Map<string, Promise<void>>();

	private fontScenes: TScene[] | null = null;

	constructor(private editor: EditorCore) {
		// Text added while the project is open (a draft, a style preset, a subtitle import) can bring a
		// font the project did not use when it opened: load it now, not on the next reopen.
		editor.scenes.subscribe(() => {
			const scenes = editor.scenes.getScenes();
			if (scenes === this.fontScenes) return;
			this.fontScenes = scenes;
			this.loadSceneFonts(scenes).catch((error) => console.error("Failed to load fonts:", error));
		});
	}

	/** Loads the fonts the scenes' text uses (shared with loads already running). */
	loadSceneFonts(scenes: TScene[] = this.editor.scenes.getScenes()): Promise<void> {
		if (typeof document === "undefined") return Promise.resolve();
		const families = scenes.flatMap((scene) => getElementFontFamilies({ tracks: scene.tracks }));
		return loadFonts({ families: [...new Set(families)] });
	}

	private async ensureStorageMigrations(): Promise<void> {
		if (this.storageMigrationPromise) {
			await this.storageMigrationPromise;
			return;
		}

		this.storageMigrationPromise = storageService.ensureMigrations();

		await this.storageMigrationPromise;
	}

	async createNewProject({ name, mode }: { name: string; mode?: ProjectMode }): Promise<string> {
		const take = this.editor.voiceOver.finishForNavigation();
		if (take) await take;
		const newProject = buildNewProject({ name, mode });

		this.advanceSession();
		this.supersedeLoads();
		// Opened before the editor's project changes: the open project's unsaved edits are kept (see SaveManager.open).
		// Nothing is written for the new project until its first write below is done.
		const saveSession = this.editor.save.open({ projectId: newProject.metadata.id, session: this.session, name, savedAt: null, loading: true });
		this.active = newProject;
		this.notify();

		this.editor.media.clearAllAssets();
		this.editor.media.markProjectMediaLoaded({ projectId: newProject.metadata.id });
		this.editor.scenes.initializeScenes({
			scenes: newProject.scenes,
			currentSceneId: newProject.currentSceneId,
		});

		try {
			await storageService.saveProject({ project: newProject });
			this.updateMetadata(newProject);
			saveSession.savedAt = new Date();

			return newProject.metadata.id;
		} catch (error) {
			toast.error(getBrowserTranslator()("projects.saveNewFailed"));
			// Not on disk: the project counts as unsaved (not ready for the agent) and autosave retries.
			saveSession.markDirty({ force: true });
			throw error;
		} finally {
			saveSession.markReady();
		}
	}

	async loadForRender(id: string, loadingMedia: () => Promise<void>, { skipFonts = false }: { skipFonts?: boolean } = {}) {
		if (!this.editor.renderOnly || this.active) throw new Error("This page cannot load a render job.");
		const loaded = await storageService.loadProject({ id, readOnly: true });
		if (!loaded || loaded.project.metadata.id !== id) throw new Error("The saved project was not found.");
		this.active = loaded.project;
		this.editor.scenes.initializeScenes({ scenes: this.active.scenes, currentSceneId: this.active.currentSceneId });
		await loadingMedia();
		await this.editor.media.loadProjectMedia({ projectId: id });
		if (!this.editor.media.isProjectMediaLoaded({ projectId: id })) throw new Error("Could not load the project's media.");
		if (!skipFonts) await this.loadProjectFonts(this.active);
		this.isLoading = false;
	}

	private loadProjectFonts(project: TProject) {
		return this.loadSceneFonts(project.scenes ?? []);
	}

	async loadProject({ id }: { id: string }): Promise<void> {
		const take = this.editor.voiceOver.finishForNavigation();
		if (take) await take;
		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		const load = ++this.loadSequence;
		const superseded = () => load !== this.loadSequence;
		// The next project is read before anything of the open one changes: if reading fails, the open
		// project stays as it was (timeline, media, saving).
		let result: Awaited<ReturnType<typeof storageService.loadProject>>;
		try {
			const attempts = 5;
			for (let attempt = 1; ; attempt++) {
				this.assertOpenable(id);
				// A rename being written: the copy read below has the new name, and the next saves keep it.
				const rename = this.renames.get(id);
				if (rename) {
					let timer: ReturnType<typeof setTimeout> | undefined;
					const done = await Promise.race([
						rename.then(() => true, () => true),
						new Promise<boolean>((resolve) => {
							timer = setTimeout(() => resolve(false), 15000);
						}),
					]);
					clearTimeout(timer);
					if (superseded()) return;
					if (!done) throw new Error("A rename of this project is still being saved; try again in a moment");
				}
				// Changes of this project that are not on disk yet (it is open, or was closed a moment ago)
				// are written first, so the read below has them.
				const unsaved = await this.editor.save.settleProject(id);
				if (superseded()) return;
				if (unsaved) throw new Error(`Earlier changes of this project are not saved yet: ${unsaved}`);
				if (this.editor.save.hasUnsavedChangesOf(id)) {
					// Edited while it was being written: write that too.
					if (attempt === attempts) throw new Error("The project kept changing while it was reopened");
					continue;
				}
				// Every edit counted so far is on disk now. One counted after this mark can be missing from
				// what is read (even if it is saved by the time the read returns): then it is read again.
				const mark = this.editor.save.editsOf(id);
				await this.ensureStorageMigrations();
				result = await storageService.loadProject({ id });
				if (!result) {
					throw new Error(`Project with id ${id} not found`);
				}
				if (superseded()) return; // a newer load started meanwhile and takes over
				this.assertOpenable(id);
				if (this.editor.save.editsOf(id) === mark) break;
				if (attempt === attempts) throw new Error("The project kept changing while it was reopened");
			}
		} catch (error) {
			console.error("Failed to load project:", error);
			// The open project (if any) stays; loading ends unless another load is still installing.
			if (!superseded() && this.installing === null && this.isLoading) {
				this.isLoading = false;
				this.notify();
			}
			throw error;
		}

		const project = result.project;
		this.advanceSession();
		// Opened before the editor's project changes: the open project's unsaved edits are taken now and
		// written in the background (see SaveManager.open). The new session saves nothing but forced
		// edits until this load is done.
		const saveSession = this.editor.save.open({ projectId: id, session: this.session, name: project.metadata.name, savedAt: project.metadata.updatedAt, loading: true });
		this.installing = load;
		this.isLoading = true;
		this.editor.media.clearAllAssets();
		this.editor.scenes.clearScenes();
		// After every await below: another project may have replaced this one; then nothing more of this
		// load runs against it.
		const installed = this.session;
		const replaced = () => this.session !== installed;

		try {
			this.active = project;
			this.notify();

			if (project.scenes && project.scenes.length > 0) {
				this.editor.scenes.initializeScenes({
					scenes: project.scenes,
					currentSceneId: project.currentSceneId,
				});
			}

			// The editor opens once the timeline's media are in; the rest of the bin goes on loading.
			await new Promise<void>((resolve) => {
				void this.editor.media.loadProjectMedia({ projectId: id, onUsedLoaded: resolve }).finally(resolve);
			});
			if (replaced()) return;

			await this.loadProjectFonts(project);

			if (replaced()) return;

		} catch (error) {
			console.error("Failed to load project:", error);
			throw error;
		} finally {
			// This load owns its session: it is ready now (a no-op once another project replaced it).
			saveSession.markReady();
			if (this.installing === load) {
				this.installing = null;
				this.isLoading = false;
				this.notify();
			}
		}
	}

	/** Writes the open project to storage now; false when it failed (a toast reports it). */
	async saveCurrentProject(): Promise<boolean> {
		return this.editor.save.flush();
	}

	/**
	 * The open project as it is in the editor now (its scenes from the editor), for writing it; null
	 * when none is open or its scenes are not in the editor (never write an empty timeline over it).
	 */
	snapshotActive(): TProject | null {
		const active = this.active;
		if (!active) return null;
		const scenes = this.editor.scenes.getScenes();
		if (scenes.length === 0 && (active.scenes?.length ?? 0) > 0) {
			console.error(`Not saved: the scenes of ${active.metadata.name} are not in the editor`);
			return null;
		}
		return {
			...active,
			scenes,
			metadata: {
				...active.metadata,
				duration: getProjectDurationFromScenes({ scenes }),
				updatedAt: new Date(),
			},
		};
	}

	/**
	 * Writes a project (see snapshotActive) to storage. Returns null on success, else the error.
	 *
	 * The active project object is not replaced: every editor component that reads it would
	 * re-render (seconds on a large project) although nothing it shows changed. Only the project
	 * list, which the editor does not show, gets the new metadata.
	 */
	async persistProject(project: TProject): Promise<string | null> {
		try {
			await storageService.saveProject({ project });
			const thumbnail = this.savedProjects.find(({ id }) => id === project.metadata.id)?.thumbnail;
			this.updateSavedMetadata({ ...project.metadata, thumbnail: thumbnail ?? project.metadata.thumbnail });
			// A project no longer in the editor (written after it closed): the project list shows it, so it
			// hears about it. The open one is not notified (see above).
			if (this.active?.metadata.id !== project.metadata.id) this.notify();
			return null;
		} catch (error) {
			console.error("Failed to save project:", error);
			return error instanceof Error ? error.message : String(error);
		}
	}

	async persistNavigation(project: TProject): Promise<string | null> {
		try {
			await storageService.saveProjectNavigation({
				id: project.metadata.id,
				navigation: { currentSceneId: project.currentSceneId, timelineViewState: project.timelineViewState },
			});
			return null;
		} catch (error) {
			console.error("Failed to save project navigation:", error);
			return error instanceof Error ? error.message : String(error);
		}
	}

	async export({
		options,
		retryResult,
		restoreMissingMedia = false,
	}: {
		options: ExportOptions;
		retryResult?: ExportResult;
		restoreMissingMedia?: boolean;
	}): Promise<ExportResult> {
		if (this.exportController) {
			return { success: false, error: "Another export is running; try again when it finishes", issue: { kind: "alreadyRunning" } };
		}
		const session = this.session;
		const isCurrentRetry = () => this.exportState.result === retryResult && this.exportTarget?.session === session;
		if (retryResult) {
			if (!isCurrentRetry()) return { success: false, cancelled: true };
			const projectId = this.active?.metadata.id;
			if (restoreMissingMedia && projectId && retryResult.missingMedia?.length) {
				await this.editor.media.retryMissingMedia({ projectId, failures: retryResult.missingMedia });
				if (!isCurrentRetry()) return { success: false, cancelled: true };
			}
		}
		const sceneId = retryResult
			? this.exportTarget?.sceneId
			: options.sceneId ?? this.editor.scenes.getCompoundPath()[0]?.sceneId;
		const target = { session, sceneId };
		this.exportTarget = target;
		const controller = new AbortController();
		this.exportController = controller;
		this.exportState = { isExporting: true, progress: 0, result: null };

		let result: ExportResult;
		try {
			this.notify();
			if (this.exportTarget !== target) {
				result = { success: false, cancelled: true };
			} else {
				result = await this.editor.renderer.exportProject({
					options: { ...options, sceneId },
					signal: controller.signal,
					onProgress: ({ progress }) => {
						if (this.exportTarget !== target) return;
						this.exportState = { ...this.exportState, progress };
						this.notify();
					},
				});
			}
		} catch (error) {
			result = getExportFailure(error);
		} finally {
			this.exportController = null;
		}

		if (this.exportTarget !== target) return { success: false, cancelled: true };
		this.exportState = {
			isExporting: false,
			progress: this.exportState.progress,
			result,
		};
		this.notify();

		return result;
	}

	cancelExport(): void {
		this.exportController?.abort();
	}

	clearExportState(): void {
		this.resetExportState();
		this.notify();
	}

	private resetExportState(): void {
		this.exportTarget = null;
		this.exportState = { isExporting: false, progress: 0, result: null };
	}

	getExportState(): ExportState {
		return this.exportState;
	}

	async loadAllProjects(): Promise<void> {
		if (!this.isInitialized) {
			this.isLoading = true;
			this.notify();
		}

		try {
			await this.ensureStorageMigrations();
			try {
				const [metadata, archived] = await Promise.all([
					storageService.loadAllProjectsMetadata(),
					// Without the list every project shows: nothing is hidden by mistake.
					storageService.loadArchivedProjectIds().catch((error) => {
						console.error("Failed to load archived projects:", error);
						return [];
					}),
				]);
				this.savedProjects = metadata;
				this.archivedIds = new Set(archived);
				this.projectListError = null;
				this.notify();
			} catch (error) {
				console.error("Failed to load projects:", error);
				// Shown instead of the empty library: the projects are still on disk.
				this.projectListError = error instanceof Error ? error.message : String(error);
			} finally {
				// A project still loading its media keeps the loading state (its load ends it).
				if (this.installing === null) this.isLoading = false;
				this.isInitialized = true;
				this.notify();
			}
		} catch (error) {
			console.error("Failed to run migrations:", error);
			if (this.installing === null) this.isLoading = false;
			this.isInitialized = true;
			this.notify();
		}
	}

	async deleteProjects({ ids }: { ids: string[] }): Promise<void> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return;

		for (const id of uniqueIds) this.deleting.add(id);
		try {
			const outcomes = await Promise.all(
				uniqueIds.map(async (id): Promise<{ id: string; error: string | null }> => {
					// No write of the project may land after the delete (it would bring it back): its writes are
					// held, and one in progress is waited for.
					if (!(await this.editor.save.holdProject(id))) {
						this.editor.save.releaseProject(id);
						return { id, error: "a save of it is still running; try again in a moment" };
					}
					try {
						// The project first: if it cannot be deleted, its media stay, so nothing it uses is lost.
						await storageService.deleteProject({ id });
					} catch (error) {
						// Not deleted: its saving goes on.
						this.editor.save.releaseProject(id);
						return { id, error: error instanceof Error ? error.message : String(error) };
					}
					// The storage delete removed the media too.
					this.deleted.add(id);
					this.editor.save.discardProject(id);
					return { id, error: null };
				}),
			);

			const deletedIds = new Set(outcomes.filter((outcome) => outcome.error === null).map((outcome) => outcome.id));
			this.savedProjects = this.savedProjects.filter(
				(project) => !deletedIds.has(project.id),
			);
			if ([...deletedIds].some((id) => this.archivedIds.has(id))) {
				this.archivedIds = new Set([...this.archivedIds].filter((id) => !deletedIds.has(id)));
			}
			if (this.active && deletedIds.has(this.active.metadata.id)) {
				this.advanceSession();
				this.active = null;
				this.editor.media.clearAllAssets();
				this.editor.scenes.clearScenes();
			}
			this.notify();

			const failed = outcomes.filter((outcome) => outcome.error !== null);
			if (failed.length > 0) {
				console.error("Failed to delete projects:", failed);
				toast.error(failed.length === 1 ? getBrowserTranslator()("projects.deleteFailed") : getBrowserTranslator()("projects.deleteManyFailed", { count: failed.length }), { description: failed[0].error ? localizeErrorDetail(failed[0].error, getBrowserTranslator()) : undefined });
			}
		} finally {
			for (const id of uniqueIds) this.deleting.delete(id);
		}
	}

	closeProject(): void {
		this.advanceSession();
		// A load still reading or loading media does not put its project in place after the close.
		this.supersedeLoads();
		// Unsaved edits are taken now and written in the background.
		this.editor.save.closeCurrent();
		if (this.active) storageService.forgetMediaManifest({ projectId: this.active.metadata.id });
		this.active = null;
		this.notify();

		this.editor.media.clearAllAssets();
		this.editor.scenes.clearScenes();
	}

	async renameProject({
		id,
		name,
	}: {
		id: string;
		name: string;
	}): Promise<void> {
		try {
			// The open project: renamed in the editor and saved by its session (its timeline is newer
			// than the stored one).
			if (this.renameActive({ id, name })) {
				if (!(await this.editor.save.flush())) toast.error(getBrowserTranslator()("projects.renameUnsaved"), { description: localizeErrorDetail(this.editor.save.getLastError(id) ?? "", getBrowserTranslator()) || getBrowserTranslator()("projects.retrySave") });
				return;
			}
			// Changes of a project closed a moment ago are written first: a retry of its last write after
			// the rename would bring the old name back.
			const unsaved = await this.editor.save.settleProject(id);
			if (unsaved) throw new Error(`Earlier changes of this project are not saved yet: ${unsaved}`);
			// Renamed on the stored copy as it is when written: a write in between is read again, so the
			// rename never puts an older timeline back. A load of the project waits for it.
			const renaming = storageService.renameProject({ id, name });
			this.renames.set(id, renaming);
			const metadata = await renaming.finally(() => {
				if (this.renames.get(id) === renaming) this.renames.delete(id);
			});
			if (!metadata) {
				toast.error(getBrowserTranslator()("projects.notFound"), {
					description: getBrowserTranslator()("common.tryAgain"),
				});
				return;
			}
			this.updateSavedMetadata(metadata);
			this.notify();
			// Opened meanwhile (from before the rename): renamed in the editor too, so its saves keep it.
			this.renameActive({ id, name });
		} catch (error) {
			console.error("Failed to rename project:", error);
			toast.error(getBrowserTranslator()("projects.renameFailed"), {
				description:
					error instanceof Error ? localizeErrorDetail(error.message, getBrowserTranslator()) : getBrowserTranslator()("common.tryAgain"),
			});
		}
	}

	private duplicateQueue: Promise<unknown> = Promise.resolve();

	/** Duplicates run one after another, so a second duplicate sees the first's "(1)" and picks "(2)". */
	duplicateProjects({ ids }: { ids: string[] }): Promise<string[]> {
		const run = this.duplicateQueue.then(() => this.duplicateNow({ ids }), () => this.duplicateNow({ ids }));
		this.duplicateQueue = run.catch(() => {});
		return run;
	}

	private async duplicateNow({ ids }: { ids: string[] }): Promise<string[]> {
		const uniqueIds = Array.from(new Set(ids));
		if (uniqueIds.length === 0) return [];

		try {
			const getDuplicateBaseName = ({ name }: { name: string }) => {
				const match = name.match(/^\((\d+)\)\s+(.+)$/);
				const number = match ? Number.parseInt(match[1], 10) : null;
				const baseName = match ? match[2] : name;
				return { baseName, number };
			};

			const loadResults = await Promise.all(
				uniqueIds.map(async (projectId) => {
					const result = await storageService.loadProject({ id: projectId });
					return { projectId, project: result?.project ?? null };
				}),
			);

			const missingProjectIds = loadResults
				.filter((result) => !result.project)
				.map((result) => result.projectId);

			if (missingProjectIds.length > 0) {
				toast.error(
					missingProjectIds.length === 1
						? getBrowserTranslator()("projects.notFound")
						: getBrowserTranslator()("projects.notFoundMany"),
					{
						description:
							missingProjectIds.length === 1
								? getBrowserTranslator()("common.tryAgain")
								: getBrowserTranslator()("projects.notFoundManyDescription"),
					},
				);
				throw new Error(`Projects not found: ${missingProjectIds.join(", ")}`);
			}

			const projectsToDuplicate = loadResults.flatMap((result) =>
				result.project ? [result.project] : [],
			);

			const maxNumberByBaseName = new Map<string, number>();

			for (const project of this.savedProjects) {
				const { baseName, number } = getDuplicateBaseName({
					name: project.name,
				});

				if (number === null) continue;

				const currentMax = maxNumberByBaseName.get(baseName);
				if (currentMax === undefined || number > currentMax) {
					maxNumberByBaseName.set(baseName, number);
				}
			}

			const nextNumberByBaseName = new Map<string, number>();
			for (const [baseName, maxNumber] of maxNumberByBaseName) {
				nextNumberByBaseName.set(baseName, maxNumber + 1);
			}

			const duplicationPlans = projectsToDuplicate.map((project) => {
				const { baseName } = getDuplicateBaseName({
					name: project.metadata.name,
				});
				const nextNumber = nextNumberByBaseName.get(baseName) ?? 1;
				nextNumberByBaseName.set(baseName, nextNumber + 1);

				const newProjectId = generateUUID();
				const newProject: TProject = {
					...project,
					metadata: {
						...project.metadata,
						id: newProjectId,
						name: `(${nextNumber}) ${baseName}`,
						createdAt: new Date(),
						updatedAt: new Date(),
					},
				};

				return {
					newProjectId,
					newProject,
					sourceProjectId: project.metadata.id,
				};
			});

			await Promise.all(
				duplicationPlans.map(async ({ newProject, newProjectId }) => {
					await storageService.saveProject({ project: newProject, includeView: true });
					const { thumbnail } = newProject.metadata;
					if (!thumbnail?.startsWith("/api/storage/projects/")) return;
					newProject.metadata.thumbnail = undefined;
					try {
						const response = await fetch(thumbnail, { signal: AbortSignal.timeout(10_000) });
						if (response.ok) {
							newProject.metadata.thumbnail = await storageService.saveProjectThumbnail({
								id: newProjectId, thumbnail: await response.blob(),
							});
						}
					} catch (error) {
						console.error("Failed to copy project thumbnail:", error);
					}
				}),
			);

			await Promise.all(
				duplicationPlans.map(async ({ sourceProjectId, newProjectId, newProject }) => {
					// Media the timeline uses are copied even if their draft's promotion never finished.
					const sourceMediaAssets = await storageService.loadAllMediaAssets({
						projectId: sourceProjectId,
						usedIds: mediaIdsInScenes(newProject.scenes ?? []),
					});

					await Promise.all(
						sourceMediaAssets.map((mediaAsset) =>
							storageService.saveMediaAsset({
								projectId: newProjectId,
								mediaAsset,
							}),
						),
					);
				}),
			);

			for (const { newProject } of duplicationPlans) {
				this.updateMetadata(newProject);
			}

			return duplicationPlans.map((plan) => plan.newProjectId);
		} catch (error) {
			console.error("Failed to duplicate projects:", error);
			toast.error(getBrowserTranslator()("projects.duplicateFailed"), {
				description:
					error instanceof Error ? localizeErrorDetail(error.message, getBrowserTranslator()) : getBrowserTranslator()("common.tryAgain"),
			});
			throw error;
		}
	}

	async updateSettings({
		settings,
		pushHistory = true,
		settingsBeforePreview,
	}: {
		settings: Partial<TProjectSettings>;
		pushHistory?: boolean;
		settingsBeforePreview?: Partial<TProjectSettings>;
	}): Promise<void> {
		if (!this.active) return;

		const command = new UpdateProjectSettingsCommand(settings, settingsBeforePreview, pushHistory);
		if (pushHistory) {
			this.editor.command.execute({ command });
			return;
		}

		command.execute();
	}

	getFpsEditRevision(): symbol | undefined {
		return this.fpsEditRevision;
	}

	setFpsEditRevision(revision: symbol | undefined): void {
		this.fpsEditRevision = revision;
	}

	ratchetFpsForImportedMedia({
		importedAssets,
	}: {
		importedAssets: Array<Pick<MediaAsset, "type" | "fps">>;
	}): import("opencut-wasm").FrameRate | null {
		if (!this.active) return null;

		const nextFps = getRaisedProjectFpsForImportedMedia({
			currentFps: this.active.settings.fps,
			importedAssets,
		});
		if (nextFps === null) return null;

		const previous = frameRateToFloat(this.active.settings.fps);
		new UpdateProjectSettingsCommand({ fps: nextFps }).execute();
		// Upstream behaviour (manual imports): the project follows the fastest footage. Say so,
		// since frame-based timing changes with it.
		const format = (fps: number) => Number(fps.toFixed(3)).toString();
		toast.info(getBrowserTranslator()("projects.raisedFps", { fps: format(frameRateToFloat(nextFps)) }), {
			description: getBrowserTranslator()("projects.raisedFpsDetail", { fps: format(previous) }),
		});
		return nextFps;
	}

	async ensureThumbnail({ session = this.session } = {}): Promise<void> {
		if (session !== this.session || this.active?.metadata.thumbnail) return;
		try {
			await this.updateThumbnailFromTimeline();
		} catch (error) {
			console.error("Failed to generate project thumbnail:", error);
		}
	}

	async prepareExit(): Promise<void> {
		const take = this.editor.voiceOver.finishForNavigation();
		if (take) await take;
		if (!this.active) return;
		this.storePlayhead();

		try {
			await this.updateThumbnailFromTimeline({ backgroundUpload: true });
		} catch (error) {
			console.error("Failed to generate project thumbnail on exit:", error);
		}
	}

	/** Hides projects from the list, or brings them back; nothing of the projects themselves changes. */
	async setProjectsArchived({ ids, archived }: { ids: string[]; archived: boolean }): Promise<boolean> {
		try {
			this.archivedIds = new Set(await storageService.setProjectsArchived({ ids, archived }));
			this.notify();
			return true;
		} catch (error) {
			console.error("Failed to change archived projects:", error);
			toast.error(getBrowserTranslator()(archived ? "projects.archiveFailed" : "projects.restoreFailed"), {
				description: error instanceof Error ? localizeErrorDetail(error.message, getBrowserTranslator()) : undefined,
			});
			return false;
		}
	}

	/**
	 * Sets what a project is for, or clears it (null). The open project changes in the editor and its
	 * session saves it; a closed one is changed on its stored copy, like a rename.
	 */
	async setProjectMode({ id, mode }: { id: string; mode: ProjectMode | null }): Promise<boolean> {
		const change = (metadata: TProjectMetadata): TProjectMetadata => {
			const { mode: _previous, ...rest } = metadata;
			return mode ? { ...rest, mode } : rest;
		};
		try {
			if (this.changeActiveMetadata({ id, change })) {
				if (!(await this.editor.save.flush())) throw new Error(this.editor.save.getLastError(id) ?? "The change is not saved yet");
				return true;
			}
			const unsaved = await this.editor.save.settleProject(id);
			if (unsaved) throw new Error(`Earlier changes of this project are not saved yet: ${unsaved}`);
			const writing = storageService.setProjectMode({ id, mode });
			this.renames.set(id, writing);
			const metadata = await writing.finally(() => {
				if (this.renames.get(id) === writing) this.renames.delete(id);
			});
			if (!metadata) throw new Error("Project not found");
			this.updateSavedMetadata(metadata);
			this.notify();
			// Opened meanwhile: changed in the editor too, so its saves keep it.
			this.changeActiveMetadata({ id, change });
			return true;
		} catch (error) {
			console.error("Failed to set the project mode:", error);
			toast.error(getBrowserTranslator()("projects.modeFailed"), {
				description: error instanceof Error ? localizeErrorDetail(error.message, getBrowserTranslator()) : undefined,
			});
			return false;
		}
	}

	isArchived({ id }: { id: string }): boolean {
		return this.archivedIds.has(id);
	}

	getArchivedCount(): number {
		return this.savedProjects.filter(({ id }) => this.archivedIds.has(id)).length;
	}

	getFilteredAndSortedProjects({
		searchQuery,
		sortOption,
		archived = false,
	}: {
		searchQuery: string;
		sortOption: TProjectSortOption;
		/** The archived projects instead of the others. */
		archived?: boolean;
	}): TProjectMetadata[] {
		const filteredProjects = this.savedProjects.filter((project) =>
			this.archivedIds.has(project.id) === archived &&
			project.name.toLowerCase().includes(searchQuery.toLowerCase()),
		);

		const [key, order] = sortOption.split("-") as [
			TProjectSortKey,
			"asc" | "desc",
		];

		const sortedProjects = [...filteredProjects].sort((a, b) => {
			const aValue = a[key];
			const bValue = b[key];

			if (order === "asc") {
				if (aValue < bValue) return -1;
				if (aValue > bValue) return 1;
				return 0;
			}
			if (aValue > bValue) return -1;
			if (aValue < bValue) return 1;
			return 0;
		});

		return sortedProjects;
	}

	isInvalidProjectId({ id }: { id: string }): boolean {
		return this.invalidProjectIds.has(id);
	}

	markProjectIdAsInvalid({ id }: { id: string }): void {
		this.invalidProjectIds.add(id);
		this.notify();
	}

	clearInvalidProjectIds(): void {
		this.invalidProjectIds.clear();
		this.notify();
	}

	getActive(): TProject {
		if (!this.active) {
			throw new Error("No active project");
		}
		return this.active;
	}

	/**
	 * for agents:
	 * in most cases, the project is guaranteed to be active, in which getActive() should be used instead.
	 * for very rare cases, this function may be used.
	 */
	getActiveOrNull(): TProject | null {
		return this.active;
	}

	getTimelineViewState(): TTimelineViewState {
		return this.active?.timelineViewState ?? DEFAULTS.timeline.viewState;
	}

	setTimelineViewState({ viewState, sceneId = this.active?.currentSceneId }: { viewState: TTimelineViewState; sceneId?: string }): void {
		if (!this.active) return;
		const current = this.getTimelineViewState();
		const sceneChanged = sceneId !== this.active.currentSceneId;
		if (
			!sceneChanged &&
			current.zoomLevel === viewState.zoomLevel &&
			current.scrollLeft === viewState.scrollLeft &&
			current.playheadTime === viewState.playheadTime
		) return;
		this.active = {
			...this.active,
			currentSceneId: sceneId ?? this.active.currentSceneId,
			timelineViewState: viewState,
		};
		this.editor.save.markNavigationDirty();
		if (sceneChanged) this.notify();
	}

	/** Takes the playhead of the open scene into the saved view. */
	storePlayhead(): void {
		this.setTimelineViewState({
			viewState: { ...this.getTimelineViewState(), playheadTime: this.editor.playback.getCurrentTime() },
		});
	}

	getSavedProjects(): TProjectMetadata[] {
		return this.savedProjects;
	}

	getIsLoading(): boolean {
		return this.isLoading;
	}

	/** Why the project list could not be read, until a later read succeeds. */
	getProjectListError(): string | null {
		return this.projectListError;
	}

	getIsInitialized(): boolean {
		return this.isInitialized;
	}

	getMigrationState(): MigrationState {
		return this.migrationState;
	}

	/** The current project session (see `session`). */
	getSession(): number {
		return this.session;
	}

	getSessionSignal(): AbortSignal {
		return this.sessionController.signal;
	}

	canImportMedia(projectId: string): boolean {
		return this.active?.metadata.id === projectId && !this.deleting.has(projectId);
	}

	private advanceSession(): void {
		if (this.editor.playback.getIsPlaying()) this.editor.playback.pause();
		const previous = this.sessionController;
		this.session++;
		this.sessionController = new AbortController();
		this.fpsEditRevision = undefined;
		this.cancelExport();
		this.resetExportState();
		this.editor.command.clear();
		this.editor.timeline.cancelPreviewGesture();
		this.editor.timeline.discardPreview();
		previous.abort();
	}

	setActiveProject({ project }: { project: TProject }): void {
		if (this.active?.metadata.id !== project.metadata.id) {
			// Another project put in place directly: it gets its own save session (the open one's unsaved
			// edits are kept, see SaveManager.open).
			this.advanceSession();
			this.supersedeLoads();
			this.editor.save.open({ projectId: project.metadata.id, session: this.session, name: project.metadata.name, savedAt: project.metadata.updatedAt, loading: false });
		}
		this.active = project;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Throws when a project cannot be opened because it is being deleted (or was). */
	private assertOpenable(id: string): void {
		// Not "not found" while the delete runs: the editor would create a new project in its place,
		// although the delete can still fail.
		if (this.deleting.has(id)) throw new Error("This project is being deleted");
		if (this.deleted.has(id)) throw new Error(`Project with id ${id} not found`);
	}

	/**
	 * The editor's project was replaced or closed directly: a load still running no longer owns it (it
	 * stops before it installs, or after its next step), and the editor is not loading any more.
	 */
	private supersedeLoads(): void {
		this.loadSequence++;
		this.installing = null;
		this.isLoading = false;
	}

	/** Renames the open project in the editor (saved by its session); false when `id` is not open. */
	private renameActive({ id, name }: { id: string; name: string }): boolean {
		return this.changeActiveMetadata({ id, change: (metadata) => ({ ...metadata, name }) });
	}

	/** Changes the open project's metadata, which its session then saves (its timeline is newer than the stored one). */
	private changeActiveMetadata({ id, change }: { id: string; change: (metadata: TProjectMetadata) => TProjectMetadata }): boolean {
		if (this.active?.metadata.id !== id) return false;
		this.active = { ...this.active, metadata: { ...change(this.active.metadata), updatedAt: new Date() } };
		this.notify();
		this.updateMetadata(this.active);
		this.editor.save.markDirty({ force: true });
		return true;
	}

	private async updateThumbnailFromTimeline({ backgroundUpload = false } = {}): Promise<boolean> {
		const activeScene = this.editor.scenes.getActiveSceneOrNull();
		if (!this.active || !activeScene || typeof document === "undefined") return false;
		const id = this.active.metadata.id;
		const generation = ++this.thumbnailGeneration;
		const signal = this.getSessionSignal();
		const { tracks } = activeScene;
		const mediaAssets = this.editor.media.getAssets();
		const duration = this.editor.timeline.getTotalDuration();
		const { background } = this.active.settings;
		const canvasSize = previewCanvasSize(this.active.settings.canvasSize);

		const scene = buildScene({
			tracks,
			mediaAssets,
			duration: duration || 1,
			canvasSize,
			background,
			scenes: this.editor.scenes.getScenes(),
		});

		const renderer = new CanvasRenderer({
			width: canvasSize.width,
			height: canvasSize.height,
			fps: this.active.settings.fps,
			renderScale: Math.min(1, 480 / Math.max(canvasSize.width, canvasSize.height)),
			exactFrames: true,
		});
		try {
			await renderer.render({ node: scene, time: 0, signal });
		} catch (error) {
			if (signal.aborted) return false;
			throw error;
		} finally {
			renderer.videoCache.clear();
		}
		const thumbnail = await new Promise<Blob | null>((resolve) =>
			renderer.getOutputCanvas().toBlob(resolve, "image/webp", 0.78),
		);
		const metadata = this.active?.metadata;
		if (!thumbnail || metadata?.id !== id || signal.aborted || generation !== this.thumbnailGeneration) return false;
		const upload = this.publishThumbnail(metadata, thumbnail);
		if (backgroundUpload) {
			void upload.catch((error) => console.error("Failed to save project thumbnail on exit:", error));
		} else {
			await upload;
		}
		return true;
	}

	private async publishThumbnail(metadata: TProjectMetadata, thumbnail: Blob): Promise<void> {
		const id = metadata.id;
		const previous = this.thumbnailUploads.get(id) ?? Promise.resolve();
		// An opening thumbnail still uploading must not replace a newer thumbnail from Exit.
		const upload = previous.catch(() => {}).then(async () => {
			if (this.deleted.has(id)) return;
			const url = await storageService.saveProjectThumbnail({ id, thumbnail });
			if (this.deleted.has(id)) return;
			const saved = this.savedProjects.find((entry) => entry.id === id) ?? metadata;
			this.updateSavedMetadata({ ...saved, thumbnail: url });
			if (this.active?.metadata.id === id) {
				this.active = { ...this.active, metadata: { ...this.active.metadata, thumbnail: url } };
			}
			this.notify();
		});
		this.thumbnailUploads.set(id, upload);
		try {
			await upload;
		} finally {
			if (this.thumbnailUploads.get(id) === upload) this.thumbnailUploads.delete(id);
		}
	}

	/** Project list entry only, without notifying (the editor does not show the list). */
	private updateSavedMetadata(metadata: TProjectMetadata): void {
		const index = this.savedProjects.findIndex((p) => p.id === metadata.id);
		this.savedProjects = index === -1 ? [metadata, ...this.savedProjects] : this.savedProjects.with(index, metadata);
	}

	private updateMetadata(project: TProject): void {
		const index = this.savedProjects.findIndex(
			(p) => p.id === project.metadata.id,
		);

		if (index !== -1) {
			this.savedProjects = this.savedProjects.with(index, project.metadata);
		} else {
			this.savedProjects = [project.metadata, ...this.savedProjects];
		}

		this.notify();
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
