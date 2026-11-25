import { localizeErrorDetail } from "@/i18n/error-details";
import { getBrowserTranslator } from "@/i18n/browser";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import { isTimelineGestureActive, subscribeTimelineGestures } from "@/timeline/gesture-state";
import { toast } from "sonner";

type SaveManagerOptions = {
	debounceMs?: number;
	/** Waits before automatic retries of a failed save; after the last one a manual retry is offered. */
	retryDelaysMs?: number[];
};

/** What a save session needs from its manager. */
type SaveHost = {
	debounceMs(): number;
	retryDelaysMs(): number[];
	/** False once the manager is stopped (editor reset): nothing is written. */
	isRunning(): boolean;
	/** False while storage migrates: writes wait. */
	canWrite(): boolean;
	/** The project of an open session as it is in the editor now, or null when it is not the editor's. */
	snapshotOf(session: SaveSession, content: boolean): TProject | null;
	/** Writes a project to storage: null on success, else the error. */
	persist(project: TProject): Promise<string | null>;
	persistNavigation(project: TProject): Promise<string | null>;
	changed(session: SaveSession): void;
	/** An edit was counted (see SaveManager.editsOf). */
	edited(session: SaveSession): void;
	/** A closed session has nothing left to write. */
	finished(session: SaveSession): void;
};

const errorToastId = (projectId: string) => `project-save-error:${projectId}`;

/**
 * The save state of one project while it is open in the editor, and after it is closed until all of
 * it is on disk. A session opens when a project is put in the editor and closes when another one
 * replaces it, or it is closed. Edits always count against the session open when they happen, so
 * nothing of one project is written as another, or reported as saved for another.
 *
 * Edits are numbered (`revision`): a write contains every edit up to the one current when it started.
 * When the session closes, the project as it is in the editor at that moment is kept (`snapshot`, by
 * reference, not copied) and written in the background, with retries if that fails. Switching
 * projects therefore never waits for a write, and never drops an edit.
 */
export class SaveSession {
	readonly projectId: string;
	/** The project manager's session this one belongs to (see ProjectManager.getSession). */
	readonly session: number;
	readonly name: string;
	/** Last successful write (at open: what storage holds). */
	savedAt: Date | null;
	/** Error of the last failed write, cleared by the next successful one. */
	lastError: string | null = null;
	private revision = 0;
	private savedRevision = 0;
	private contentRevision = 0;
	private savedContentRevision = 0;
	private navigationRevision = 0;
	/** The load that opened this session is still running: only forced edits count, nothing is written. */
	private loading: boolean;
	private closed = false;
	/** Discarded (project deleted, manager stopped): nothing more happens. */
	private detached = false;
	/** Writes wait (a delete of the project is running, see hold). */
	private held = false;
	private snapshot: TProject | null = null;
	private writing: Promise<void> | null = null;
	/** The project the write in progress writes, and the revision it covers. */
	private inFlight: { target: number; project: TProject } | null = null;
	/** Someone waits for the write after the one in progress: it starts right away. */
	private urgent = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private failures = 0;
	/** Resolved with the project as written by the first write that contains their revision (null: discarded). */
	private savedWaiters: { revision: number; resolve: (written: TProject | null) => void }[] = [];
	private failureWaiters = new Set<() => void>();

	constructor(
		private host: SaveHost,
		{ projectId, session, name, savedAt, loading }: { projectId: string; session: number; name: string; savedAt: Date | null; loading: boolean },
	) {
		this.projectId = projectId;
		this.session = session;
		this.name = name;
		this.savedAt = savedAt;
		this.loading = loading;
	}

	/** Some edit is not on disk yet (also while it is being written). */
	isDirty(): boolean {
		return this.revision > this.savedRevision;
	}

	isLoading(): boolean {
		return this.loading;
	}

	isClosed(): boolean {
		return this.closed;
	}

	/**
	 * Counts an edit and schedules a write; returns the edit's revision. While the session loads only
	 * forced edits count (opening a project notifies changes that are not edits). A closed session takes
	 * no edits.
	 */
	markDirty({ force = false, navigation = false }: { force?: boolean; navigation?: boolean } = {}): number {
		if (this.closed || this.detached || (this.loading && !force)) return this.revision;
		const wasDirty = this.isDirty();
		this.revision++;
		if (navigation) this.navigationRevision = this.revision;
		else this.contentRevision = this.revision;
		this.host.edited(this);
		this.schedule(this.host.debounceMs());
		if (!wasDirty) this.host.changed(this);
		return this.revision;
	}

	/** The load that opened this session is done: forced edits made while it ran are written now. */
	markReady(): void {
		if (!this.loading) return;
		this.loading = false;
		if (this.isDirty()) this.schedule(0);
		this.host.changed(this);
	}

	/**
	 * Another project replaces this one (or it is closed): `snapshot` gives the project as it is in the
	 * editor now, taken only if something is unsaved. Call it before the editor's project changes.
	 */
	close(snapshot: (content: boolean) => TProject | null): void {
		if (this.closed) return;
		this.closed = true;
		this.loading = false;
		this.clearTimer();
		if (!this.isDirty()) {
			this.host.finished(this);
			return;
		}
		// The write in progress already has every edit: its project is the snapshot (nothing recomputed).
		this.snapshot = this.writing && this.inFlight?.target === this.revision
			? this.inFlight.project
			: snapshot(this.contentRevision > this.savedContentRevision);
		if (!this.snapshot) {
			this.lastError = "the project could not be read from the editor to save it";
			console.error(`Unsaved changes of ${this.name} could not be kept:`, this.lastError);
			for (const fail of [...this.failureWaiters]) fail();
			return;
		}
		if (!this.writing) void this.write();
	}

	/** Forgets everything unsaved (the project was deleted, or the editor reset). */
	discard(): void {
		if (this.detached) return;
		this.detached = true;
		this.closed = true;
		this.loading = false;
		this.snapshot = null;
		this.clearTimer();
		for (const waiter of this.savedWaiters.splice(0)) waiter.resolve(null);
		for (const fail of [...this.failureWaiters]) fail();
	}

	/**
	 * Resolves with the project as written by the first successful write that contains `revision`
	 * (whenever that is; it can hold later edits too, such as an undo). Null if the session is discarded,
	 * or if `revision` was already on disk when this was called (call it right after the edit).
	 */
	whenSaved(revision = this.revision): Promise<TProject | null> {
		if (this.savedRevision >= revision || this.detached) return Promise.resolve(null);
		return new Promise((resolve) => this.savedWaiters.push({ revision, resolve }));
	}

	/** Stops writes (the project is being deleted); resolves once the write in progress, if any, is done. */
	hold(): Promise<void> {
		this.held = true;
		this.clearTimer();
		return this.writing ?? Promise.resolve();
	}

	/** Writes go on after hold (the delete failed). */
	release(): void {
		if (!this.held) return;
		this.held = false;
		if (this.isDirty()) this.schedule(this.host.debounceMs());
	}

	/**
	 * Writes now what is not on disk up to `revision`: true once it is, false when a write fails, saving
	 * is off, or `timeoutMs` passes (a write hangs, or the project is still loading).
	 */
	settle(revision = this.revision, { timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<boolean> {
		if (this.savedRevision >= revision) return Promise.resolve(true);
		if (this.detached || !this.host.isRunning() || (this.closed && !this.snapshot)) return Promise.resolve(false);
		return new Promise((resolve) => {
			let done = false;
			// Removed again however this ends, so repeated settles on a hung write keep nothing behind.
			const waiter = { revision, resolve: (written: TProject | null) => finish(written !== null) };
			const finish = (saved: boolean) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				this.failureWaiters.delete(fail);
				const index = this.savedWaiters.indexOf(waiter);
				if (index !== -1) this.savedWaiters.splice(index, 1);
				resolve(saved);
			};
			const fail = () => finish(false);
			const timer = setTimeout(fail, timeoutMs);
			this.failureWaiters.add(fail);
			this.savedWaiters.push(waiter);
			this.writeNow();
		});
	}

	/** Saves again now after failures (the error toast's Retry button). */
	retry(): void {
		this.failures = 0;
		this.writeNow();
	}

	/** The manager started again (after stop): what is pending is written. */
	resume(): void {
		if (this.isDirty()) this.schedule(this.host.debounceMs());
	}

	private writeNow(): void {
		this.clearTimer();
		if (this.writing) this.urgent = true;
		else void this.write();
	}

	private schedule(delayMs: number): void {
		if (this.writing || this.detached || this.loading || this.held || !this.host.isRunning()) return;
		this.clearTimer();
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.write();
		}, delayMs);
	}

	private async write(): Promise<void> {
		if (this.writing || this.detached || this.loading || this.held || !this.host.isRunning() || !this.isDirty()) return;
		if (!this.host.canWrite()) {
			this.schedule(this.host.debounceMs());
			return;
		}
		// A closed session takes no edits, so its snapshot holds every revision.
		const target = this.revision;
		const content = this.contentRevision;
		const saveContent = content > this.savedContentRevision;
		const saveNavigation = this.navigationRevision > this.savedRevision;
		const project = this.closed ? this.snapshot : this.host.snapshotOf(this, saveContent);
		if (!project) return;
		this.clearTimer();
		this.urgent = false;
		this.inFlight = { target, project };
		const run = (async () => {
			let error: string | null = null;
			if (saveContent) {
				error = await this.host.persist(project);
				if (error === null) {
					this.savedContentRevision = content;
					this.savedAt = new Date();
				}
			}
			// A newly opened scene can be part of the content edit. Commit content first, and
			// retry just the small record if navigation fails after the timeline was saved.
			if (error === null && saveNavigation && !this.detached) error = await this.host.persistNavigation(project);
			this.writing = null;
			this.inFlight = null;
			if (this.detached) return;
			let retryIn: number | null = null;
			if (error === null) {
				if (this.lastError) toast.dismiss(errorToastId(this.projectId));
				this.failures = 0;
				this.lastError = null;
				this.savedRevision = Math.max(this.savedRevision, target);
				const due = this.savedWaiters.filter((waiter) => waiter.revision <= this.savedRevision);
				this.savedWaiters = this.savedWaiters.filter((waiter) => waiter.revision > this.savedRevision);
				for (const waiter of due) waiter.resolve(project);
			} else {
				// Not on disk: stays dirty (readiness reports it) and is retried with backoff, whether or not
				// anything else changes.
				this.lastError = error;
				const delays = this.host.retryDelaysMs();
				retryIn = delays[Math.min(this.failures, delays.length - 1)];
				this.failures++;
				for (const fail of [...this.failureWaiters]) fail();
				const t = getBrowserTranslator();
				const what = this.closed ? t("storage.saveNamedFailed", { name: this.name }) : t("storage.saveFailed");
				const detail = localizeErrorDetail(error, t);
				toast.error(what, {
					id: errorToastId(this.projectId),
					description: t("storage.retryIn", { error: detail, seconds: Math.round(retryIn / 1000) }),
					duration: Number.POSITIVE_INFINITY,
					action: { label: t("common.retry"), onClick: () => this.retry() },
				});
			}
			if (this.closed && !this.isDirty()) {
				this.snapshot = null;
				this.host.finished(this);
			} else if (this.isDirty()) {
				// After a failure only the backoff retries (a waiting settle already got false).
				if (error === null) this.schedule(this.urgent ? 0 : this.host.debounceMs());
				else if (retryIn !== null) this.schedule(retryIn);
			}
			this.host.changed(this);
		})();
		this.writing = run;
		this.host.changed(this);
		await run;
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearTimeout(this.timer);
		this.timer = null;
	}
}

/**
 * Autosave. Every opened project gets its own SaveSession (see there); the manager routes edits to the
 * session of the project in the editor and keeps closed sessions until their last changes are on disk.
 */
export class SaveManager {
	private debounceMs: number;
	private retryDelaysMs: number[];
	private running = false;
	private unsubscribeHandlers: Array<() => void> = [];
	private current: SaveSession | null = null;
	/** Closed sessions whose last changes are not on disk yet. */
	private closing = new Set<SaveSession>();
	/** Last known save state per project (also after its session closed). */
	private projects = new Map<string, { savedAt: Date | null; error: string | null }>();
	/** Edits counted per project, across its sessions (only grows). */
	private edits = new Map<string, number>();
	/** Registered while anything is unsaved or being edited: the browser asks before the page is left. */
	private unloadGuard: ((event: BeforeUnloadEvent) => void) | null = null;
	private listeners = new Set<() => void>();
	private host: SaveHost;

	constructor({
		editor,
		debounceMs = 800,
		retryDelaysMs = [1000, 2000, 4000, 8000, 16000, 30000],
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
		this.retryDelaysMs = retryDelaysMs;
		this.host = {
			debounceMs: () => this.debounceMs,
			retryDelaysMs: () => this.retryDelaysMs,
			isRunning: () => this.running,
			canWrite: () => !this.editor.project.getMigrationState().isMigrating,
			snapshotOf: (session, content) => {
				const project = this.editor.project;
				if (session !== this.current || project.getActiveOrNull()?.metadata.id !== session.projectId || project.getSession() !== session.session) {
					console.error(`Not saved: ${session.name} is no longer the project in the editor`);
					return null;
				}
				return content ? project.snapshotActive() : project.getActive();
			},
			persist: (project) => this.editor.project.persistProject(project),
			persistNavigation: (project) => this.editor.project.persistNavigation(project),
			changed: (session) => {
				this.projects.set(session.projectId, { savedAt: session.savedAt, error: session.lastError });
				this.notify();
			},
			edited: (session) => {
				this.edits.set(session.projectId, (this.edits.get(session.projectId) ?? 0) + 1);
			},
			finished: (session) => {
				if (this.closing.delete(session)) this.notify();
			},
		};
	}

	private editor: EditorCore;

	start(): void {
		if (this.running) return;
		this.running = true;
		let scenes = this.editor.scenes.getScenes();
		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				const next = this.editor.scenes.getScenes();
				if (next === scenes) return;
				scenes = next;
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => this.updateUnloadGuard()),
			subscribeTimelineGestures(() => this.updateUnloadGuard()),
		];
		this.current?.resume();
		for (const session of this.closing) session.resume();
	}

	/** Stops saving (editor reset): sessions are discarded, a write still running changes nothing. */
	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.running = false;
		this.current?.discard();
		this.current = null;
		for (const session of this.closing) session.discard();
		this.closing.clear();
		this.updateUnloadGuard();
	}

	/**
	 * Opens the save session of a project being put in the editor. The open session is closed first, so
	 * call this before the editor's project or scenes change (see closeCurrent).
	 */
	open({ projectId, session, name, savedAt, loading }: { projectId: string; session: number; name: string; savedAt: Date | null; loading: boolean }): SaveSession {
		this.closeCurrent();
		const opened = new SaveSession(this.host, { projectId, session, name, savedAt, loading });
		this.current = opened;
		this.projects.set(projectId, { savedAt, error: null });
		this.notify();
		return opened;
	}

	/**
	 * Closes the open session: what is not saved is taken from the editor now and written in the
	 * background. Call it before the editor's project or scenes change.
	 */
	closeCurrent(): void {
		const closing = this.current;
		if (!closing) return;
		this.current = null;
		this.closing.add(closing);
		closing.close((content) => content ? this.editor.project.snapshotActive() : this.editor.project.getActiveOrNull());
		this.notify();
	}

	/** Forgets everything unsaved of a deleted project. */
	discardProject(projectId: string): void {
		for (const session of [...this.closing, this.current]) {
			if (session?.projectId !== projectId) continue;
			session.discard();
			this.closing.delete(session);
			if (session === this.current) this.current = null;
		}
		this.projects.delete(projectId);
		this.notify();
	}

	/**
	 * Holds the writes of a project that is about to be deleted, and waits (at most `timeoutMs`) for a
	 * write in progress: a write landing after the delete would bring the project back. True once
	 * nothing is being written; call releaseProject if the delete does not happen.
	 */
	async holdProject(projectId: string, { timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<boolean> {
		const writes = Promise.all(this.sessionsOf(projectId).map((session) => session.hold()));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = await Promise.race([
			writes.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
		clearTimeout(timer);
		return done;
	}

	/** Lets the writes of a held project go on (its delete failed). */
	releaseProject(projectId: string): void {
		for (const session of this.sessionsOf(projectId)) session.release();
	}

	/**
	 * How many edits of a project were counted so far (only grows): a reader compares it before and
	 * after reading the project, to know whether what it read can be older than the editor's state.
	 */
	editsOf(projectId: string): number {
		return this.edits.get(projectId) ?? 0;
	}

	/**
	 * Writes everything of a project that is not on disk yet (its open session and closed ones), e.g.
	 * before it is read again. Null once it is all on disk, else why not.
	 */
	async settleProject(projectId: string, { timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<string | null> {
		const sessions = this.sessionsOf(projectId).filter((session) => session.isDirty());
		const saved = await Promise.all(sessions.map((session) => session.settle(undefined, { timeoutMs })));
		const failed = sessions.find((_, i) => !saved[i]);
		if (!failed) return null;
		return failed.lastError ?? (this.running ? "the save did not finish in time" : "saving is off");
	}

	/** Something of this project (open or closed session) is not on disk yet. */
	hasUnsavedChangesOf(projectId: string): boolean {
		return this.sessionsOf(projectId).some((session) => session.isDirty());
	}

	/** Something of any project is not on disk yet (the page should not be left). */
	hasUnsavedChanges(): boolean {
		return !!this.current?.isDirty() || [...this.closing].some((session) => session.isDirty());
	}

	/** False after stop() until start(). */
	isRunning(): boolean {
		return this.running;
	}

	/** The session of the project in the editor, or null. */
	getCurrent(): SaveSession | null {
		return this.current;
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		this.current?.markDirty({ force });
	}

	markNavigationDirty(): void {
		this.current?.markDirty({ navigation: true });
	}

	/** Writes the open project now: true once it is on disk. */
	async flush(): Promise<boolean> {
		const session = this.current;
		if (!session) return false;
		return session.settle(session.markDirty({ force: true }));
	}

	/** Saves the open project again now after a failure. */
	retry(): void {
		this.current?.retry();
	}

	/** The open project has changes that are not on disk yet. */
	getIsDirty(): boolean {
		return !!this.current?.isDirty();
	}

	/** Last successful write of the project (the open one by default) to storage. */
	getLastSavedAt(projectId = this.current?.projectId): Date | null {
		return (projectId && this.projects.get(projectId)?.savedAt) || null;
	}

	/** Error of the project's last failed save, cleared by the next successful one. */
	getLastError(projectId = this.current?.projectId): string | null {
		return (projectId && this.projects.get(projectId)?.error) || null;
	}

	/** Notified when a write starts or ends and when changes become pending. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Writes the open project's pending changes now: true once they are on disk, false when a write
	 * failed or `timeoutMs` passed.
	 */
	async settle({ timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<boolean> {
		const session = this.current;
		if (!session) return true;
		return session.settle(undefined, { timeoutMs });
	}

	private sessionsOf(projectId: string): SaveSession[] {
		return [...this.closing, ...(this.current ? [this.current] : [])].filter((session) => session.projectId === projectId);
	}

	private notify(): void {
		this.updateUnloadGuard();
		for (const listener of this.listeners) listener();
	}

	/** Also covers a project closed a moment ago, after the editor page itself is gone. */
	private updateUnloadGuard(): void {
		if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
		const needed = this.running && (
			this.hasUnsavedChanges() || this.editor.timeline.isPreviewActive() || isTimelineGestureActive()
		);
		if (needed && !this.unloadGuard) {
			this.unloadGuard = (event) => {
				event.preventDefault();
				(event as unknown as { returnValue: string }).returnValue = "";
			};
			window.addEventListener("beforeunload", this.unloadGuard);
		} else if (!needed && this.unloadGuard) {
			window.removeEventListener("beforeunload", this.unloadGuard);
			this.unloadGuard = null;
		}
	}
}
