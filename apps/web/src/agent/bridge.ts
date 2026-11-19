// Every timeline change is written to AGENT_WORKSPACE/project.json (seconds, pixels),
// so the agent can see each item's location, time, and position without opening the browser.
import { EditorCore } from "@/core";
import { toast } from "sonner";
import { pollFrames } from "./frames";
import { loadIcon } from "@/stickers/providers/iconify";
import { createEditLogger, type EditSnapshot } from "./edit-log";
import { type AgentElement, type LoadedMedia, assetKey, existingAgentMedia, stageAgentAsset } from "./elements";
import { walkAgentElements } from "./compound-content";
import { type Draft, type DraftOp, computeAgentDraft } from "./draft";
import { AgentDraftCommand } from "./draft-command";
import { getRootScene, selectionInScene } from "./scene-graph";
import { s, buildEditItems, buildSceneSnapshot } from "./snapshot";
import { NO_SELECTION } from "./selection-payload";
import { mediaIdsInScenes } from "@/core/managers/media-manager";
import { loadTextPresets } from "@/text/presets";
import { resolveCaptionPreset } from "./captions";

export type { Draft, DraftOp } from "./draft";

function mediaNames() {
	return new Map(EditorCore.getInstance().media.getAssets().map((m) => [m.id, m.name]));
}

/** The root timeline the agent reads and edits (the open scene, or the user scene around the open compound). */
export function agentRootScene() {
	const editor = EditorCore.getInstance();
	return getRootScene(editor.scenes.getScenes(), editor.scenes.getActiveSceneOrNull()?.id ?? null);
}

/**
 * Whether the editor is safe for the agent: the project is loaded, loading its stored media has
 * finished, and every change is saved to disk. Drafts and frame requests wait for it; the sync
 * snapshot reports it. Stored media that could not be read do not block readiness: they are listed
 * in `missingMedia` so the agent can decide (frames refuse them unless the request allows it).
 */
export function agentReadiness() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const projectId = project?.metadata.id ?? null;
	const mediaLoaded = !!projectId && editor.media.isProjectMediaLoaded({ projectId });
	const missingMedia = mediaLoaded ? editor.media.getMissingMedia() : [];
	const pendingSave = editor.save.getIsDirty();
	const saveError = projectId ? editor.save.getLastError(projectId) : null;
	const savedAt = (projectId && editor.save.getLastSavedAt(projectId)?.toISOString()) || null;
	const ready = !!project && !editor.project.getIsLoading() && mediaLoaded && !pendingSave && !saveError;
	return { ready, mediaLoaded, missingMedia, pendingSave, saveError, savedAt };
}

/** Resolves true once agentReadiness().ready, false after `timeoutMs`. */
export async function whenAgentReady({ timeoutMs = 120000 }: { timeoutMs?: number } = {}): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!agentReadiness().ready) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return true;
}

export function agentSnapshot() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	const scene = agentRootScene();
	if (!project || !active || !scene) return null;
	const view = buildSceneSnapshot({ scenes: editor.scenes.getScenes(), rootSceneId: scene.id, mediaName: mediaNames() });
	const { ready, mediaLoaded, missingMedia, pendingSave, saveError, savedAt } = agentReadiness();
	return {
		schema: "opencut-agent-sync-1", projectId: project.metadata.id, projectName: project.metadata.name,
		// ready = media loaded and nothing left to save; savedAt = last write of project.json; syncedAt = this snapshot.
		ready, mediaLoaded, mediaCount: editor.media.getAssets().length, missingMedia, pendingSave, saveError, savedAt, syncedAt: new Date().toISOString(),
		canvas: project.settings.canvasSize, fps: project.settings.fps,
		note: "Times are in seconds. transform.positionX/Y = pixels from the canvas center. Overlay index 0 = topmost. Inside compounds, start/end are relative to the compound's content; visible = intervals in the root timeline.",
		sceneId: scene.id, activeSceneId: active.id,
		notes: scene.bookmarks.filter((b) => b.note?.trim()).map((b) => ({ id: b.id ?? `legacy-${b.time}`, text: b.note, start: s(b.time), ...(b.duration ? { end: s(b.time + b.duration) } : {}), elementIds: b.elementIds ?? [], replies: b.replies ?? [], author: b.author ?? "user", resolved: b.resolved ?? false, createdAt: b.createdAt ?? null })),
		tracks: view.tracks,
		compounds: view.compounds,
		selection: agentSelection(view),
	};
}

/**
 * What the user is pointing at: the selected elements (as they appear in the snapshot, with their track) and
 * the playhead (seconds, in the open scene). Agents resolve "this" from unresolved notes first, then this.
 */
export function agentSelection(view?: ReturnType<typeof buildSceneSnapshot>) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	const scene = agentRootScene();
	if (!project || !active || !scene) return null;
	const snapshot = view ?? buildSceneSnapshot({ scenes: editor.scenes.getScenes(), rootSceneId: scene.id, mediaName: mediaNames() });
	const lanes = active.id === scene.id ? snapshot.tracks : (snapshot.compounds.find((c) => c.sceneId === active.id)?.tracks ?? []);
	const selected = editor.selection.getSelectedElements().flatMap(({ trackId, elementId }) => {
		const lane = lanes.find((l) => l.id === trackId);
		const element = lane?.elements.find((e) => e.id === elementId);
		return element && lane ? [{ ...element, track: { id: lane.id, name: lane.name, type: lane.type } }] : [];
	});
	return { projectId: project.metadata.id, sceneId: scene.id, activeSceneId: active.id, playhead: s(editor.playback.getCurrentTime()), selected };
}

function editSnapshot(): EditSnapshot | null {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const scene = agentRootScene();
	if (!project || !scene) return null;
	return { projectId: project.metadata.id, items: buildEditItems({ scenes: editor.scenes.getScenes(), rootSceneId: scene.id, mediaName: mediaNames() }) };
}
let editLogger: ReturnType<typeof createEditLogger> | undefined;
let installed = false;
export function installAgentBridge() {
	if (installed || typeof window === "undefined") return;
	installed = true;
	const editor = EditorCore.getInstance();
	let timer: ReturnType<typeof setTimeout> | undefined;
	editLogger = createEditLogger(editSnapshot, () => editor.timeline.isPreviewActive(), (lines) => {
		fetch("/api/agent/edits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lines) }).catch(() => {});
	});
	const sync = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			const snap = agentSnapshot();
			if (snap) fetch("/api/agent/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap) }).catch(() => {});
		}, 800);
	};
	const push = () => {
		editLogger?.changed();
		sync();
	};
	editor.timeline.subscribe(push);
	editor.scenes.subscribe(push);
	// selection.json: what the user points at, written shortly after the selection or the playhead settles.
	let selectionTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSelection = "";
	const pushSelection = () => {
		clearTimeout(selectionTimer);
		selectionTimer = setTimeout(() => {
			// No open project: an empty selection, so an agent never acts on a closed project's selection.
			const body = JSON.stringify(agentSelection() ?? NO_SELECTION);
			if (body === lastSelection) return;
			lastSelection = body;
			fetch("/api/agent/selection", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {
				lastSelection = "";
			});
		}, 250);
	};
	editor.selection.subscribe(pushSelection);
	editor.playback.subscribe(pushSelection);
	editor.timeline.subscribe(pushSelection);
	editor.scenes.subscribe(pushSelection);
	editor.project.subscribe(pushSelection);
	pushSelection();
	// Re-sync when readiness changes (media finished loading, a save landed) so the snapshot tells the truth.
	let readiness = "";
	const readinessChanged = () => {
		const { ready, mediaLoaded, missingMedia, pendingSave, saveError } = agentReadiness();
		const key = JSON.stringify([ready, mediaLoaded, missingMedia.length, pendingSave, saveError]);
		if (key !== readiness) {
			readiness = key;
			sync();
		}
	};
	editor.save.subscribe(readinessChanged);
	editor.media.subscribe(readinessChanged);
	editor.project.subscribe(readinessChanged);
	const retryMissingMedia = () => {
		const project = editor.project.getActiveOrNull();
		return project ? editor.media.retryMissingMedia({ projectId: project.metadata.id }) : Promise.resolve([]);
	};
	(window as any).agent = { editor, snapshot: agentSnapshot, selection: agentSelection, push, applyDraft, ready: agentReadiness, whenReady: whenAgentReady, retryMissingMedia };
	push();
	setInterval(pollDraft, 2000);
	// Frames wait for media and saves too: otherwise a frame can miss content that is still loading.
	setInterval(() => {
		void framesGate().then((request) => (request ? pollFrames(request) : undefined));
	}, 2000);
}

// A frame request is refused (once per rev, with an error result) while stored media are
// missing, unless it says `allowMissing: true`: frames would silently lack that content.
let refusedFramesRev: string | null = null;
async function framesGate(): Promise<unknown | null> {
	const { ready, missingMedia } = agentReadiness();
	if (!ready) return null;
	let request: { rev?: unknown; allowMissing?: unknown } | null = null;
	try {
		request = await (await fetch("/api/agent/frames-request", { cache: "no-store" })).json();
	} catch {
		return null;
	}
	if (!request || typeof request.rev !== "string") return null;
	if (missingMedia.length === 0 || request.allowMissing === true) return request;
	if (refusedFramesRev !== request.rev) {
		refusedFramesRev = request.rev;
		const projectId = EditorCore.getInstance().project.getActiveOrNull()?.metadata.id;
		await fetch("/api/agent/frames-result", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rev: request.rev, projectId, files: [], error: `${missingMedia.length} stored media could not be loaded; retry them (window.agent.retryMissingMedia()) or send allowMissing:true`, missingMedia }),
		}).catch(() => {});
	}
	return null;
}

// An agent draft is a list of per-item operations, protecting human edits (see AGENT.md and draft.ts).
// Times are in seconds; inside a compound clip they are relative to its content. The whole draft is one Undo step.
let applying = false;
/** Picks up draft.json for the open project (every 2 s; exported for tests). */
export async function pollDraft() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || applying) return;
	if (editor.timeline.isPreviewActive()) return; // a human is dragging: wait until release
	if (!agentReadiness().ready) return; // media still loading or a save pending: the draft waits
	// The session is taken before the fetch: a project opened while draft.json is read is not the
	// one this poll was for, and the draft is left for the next poll (not marked seen, not refused).
	const session = currentSession();
	let draft: Draft | null = null;
	try {
		draft = await (await fetch("/api/agent/draft", { cache: "no-store" })).json();
	} catch {
		return;
	}
	if (!draft?.rev || (draft.projectId && draft.projectId !== project.metadata.id)) return;
	if (draftSessionError({ draft, queued: session, now: currentSession() }) || !agentReadiness().ready) return;
	const key = `agent-draft-${project.metadata.id}`;
	if (localStorage.getItem(key) === draft.rev) return;
	localStorage.setItem(key, draft.rev);
	applying = true;
	try {
		await applyDraft(draft, { session });
	} finally {
		applying = false;
	}
}

// Drafts run one at a time, whoever calls applyDraft (the poller or the console).
let draftQueue: Promise<void> = Promise.resolve();

/** Elements an op builds (with compound content), whose icons and assets load before the timeline changes. */
function elementsOf(op: DraftOp): AgentElement[] {
	if (op?.op === "add") return op.element ? [...walkAgentElements([op.element])] : [];
	if (op?.op === "replace") return op.element && typeof op.element === "object" ? [...walkAgentElements([op.element as AgentElement])] : [];
	if (op?.op === "compound") return [...walkAgentElements([...(op.main ?? []), ...(op.overlay ?? []).flatMap((t) => t.elements ?? []), ...(op.audio ?? []), ...(op.elements ?? [])])];
	return [];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const opLabel = (op: DraftOp) => (op?.op === "add" ? { name: op.element?.name } : { agentId: (op as { agent_id?: string })?.agent_id });

/**
 * Applies a draft as one Undo step; drafts run one after another. Every icon and asset (and every
 * `mediaId`) is loaded before the timeline changes, and imported assets stay private (staged) until
 * the draft commits: if anything fails, nothing is applied, the staged imports are deleted (nothing
 * can be using them), and every failure is reported, including files that could not be removed.
 * Once applied, the project is saved before the result is written, so `draft-result.json` with
 * `saved: true` means the change is in project.json on disk.
 */
export function applyDraft(draft: Draft, { session = currentSession() }: { session?: DraftSession | null } = {}): Promise<void> {
	// Bound now: a draft waiting behind another one never runs against a project opened meanwhile.
	const run = draftQueue.then(() => applyDraftNow(draft, session));
	draftQueue = run.catch(() => {});
	return run;
}

const usedMediaIds = mediaIdsInScenes;

/** The project session a draft was queued in: its project id and the project manager's session. */
export type DraftSession = { projectId: string; session: number };

/** The project session open now, or null. */
function currentSession(): DraftSession | null {
	const editor = EditorCore.getInstance();
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	return projectId ? { projectId, session: editor.project.getSession() } : null;
}

/** Why a draft cannot run in the session open now, or null when it can. */
export function draftSessionError({ draft, queued, now }: { draft: Pick<Draft, "projectId">; queued: DraftSession | null; now: DraftSession | null }): string | null {
	if (!queued) return "no project was open when the draft was queued";
	if (!now || now.projectId !== queued.projectId || now.session !== queued.session) return "another project was opened before the draft ran; nothing was applied";
	if (draft.projectId !== undefined && draft.projectId !== null && draft.projectId !== queued.projectId) return `the draft is for project ${String(draft.projectId)}, not the open one; nothing was applied`;
	return null;
}

async function applyDraftNow(draft: Draft, session: DraftSession | null) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	const refused = draftSessionError({ draft, queued: session, now: currentSession() });
	if (refused) {
		const projectId = session?.projectId ?? project?.metadata.id;
		const ops: DraftOp[] = Array.isArray(draft?.ops) ? draft.ops : [];
		toast.error(`Agent draft not applied: ${draft.label ?? draft.rev}`, { description: refused });
		await fetch("/api/agent/applied", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rev: draft.rev, label: draft.label, appliedAt: new Date().toISOString(), projectId, ok: false, applied: false, error: refused, results: ops.map((op) => ({ op: op?.op, ...opLabel(op), ok: false, skipped: true })) }),
		}).catch(() => {});
		return;
	}
	if (!project || !active || !agentRootScene()) return;
	const projectId = project.metadata.id;
	const ops: DraftOp[] = Array.isArray(draft?.ops) ? structuredClone(draft.ops) : [];
	const report = (body: Record<string, unknown>) =>
		fetch("/api/agent/applied", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rev: draft.rev, label: draft.label, appliedAt: new Date().toISOString(), projectId, ...body }),
		}).catch(() => {});

	// Load icons and assets first (async), then change the timeline at once.
	const media = new Map<AgentElement, LoadedMedia>();
	const byPath = new Map<string, Promise<LoadedMedia>>();
	let presets: ReturnType<typeof loadTextPresets> | undefined;
	// Every import attempted, recorded before anything is written (also those whose save failed).
	const staged: string[] = [];
	const failures: (string | undefined)[] = [];
	// Element trees are walked once, before anything is imported: a malformed tree (e.g. a null element
	// inside a compound) fails its op instead of throwing after assets were staged.
	const opElements = ops.map((op): AgentElement[] | Error => {
		try {
			return elementsOf(op);
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	});
	const elementsOfOp = (i: number): AgentElement[] => {
		const elements = opElements[i];
		return elements instanceof Error ? [] : elements;
	};
	for (const [i, op] of ops.entries()) {
		const errors: string[] = [];
		const walked = opElements[i];
		if (walked instanceof Error) {
			failures[i] = `invalid elements: ${walked.message}`;
			continue;
		}
		if (op.op === "set" && op.caption?.preset) {
			try {
				op.caption = resolveCaptionPreset(op.caption, await (presets ??= loadTextPresets()));
			} catch (error) {
				errors.push(`caption: ${errorText(error)}`);
			}
		}
		for (const e of walked) {
			if (!e || typeof e !== "object") {
				errors.push("an element is not an object");
				continue;
			}
			try {
				if (e.caption?.preset) e.caption = resolveCaptionPreset(e.caption, await (presets ??= loadTextPresets()));
				if (e.icon) e.icon = { ...e.icon, svg: await loadIcon(e.icon.name) };
				if (e.mediaId !== undefined) {
					if (typeof e.mediaId !== "string") throw new Error("mediaId must be a string");
					media.set(e, existingAgentMedia(e));
				} else if (e.asset && typeof e.asset !== "string") {
					const asset = e.asset;
					const key = assetKey(asset);
					if (!byPath.has(key)) byPath.set(key, stageAgentAsset({ projectId, asset, onId: (id) => staged.push(id) }));
					media.set(e, await byPath.get(key)!);
				}
			} catch (error) {
				errors.push(`${e.agent_id ?? e.name}: ${errorText(error)}`);
			}
		}
		if (errors.length) failures[i] = errors.join("; ");
	}
	/** Removes staged imports (all, or those `keep` does not need) and reports what could not be removed. */
	const discard = async (keep: Set<string> = new Set()) => {
		const drop = staged.filter((id) => !keep.has(id));
		if (drop.length === 0) return null;
		const cleanup = await editor.media.discardStagedMediaAssets({ ids: drop });
		return cleanup;
	};
	const cleanupNote = (cleanup: Awaited<ReturnType<typeof discard>>) =>
		cleanup?.failed.length ? `; ${cleanup.failed.length} imported ${cleanup.failed.length === 1 ? "file" : "files"} could not be removed from storage` : "";
	// Loading (for example a slow URL section) took a while. If another project is open now, its timeline
	// is not the one this draft was made for, and the staged imports belong to the first project: stop here.
	if (draftSessionError({ draft, queued: session, now: currentSession() })) {
		const cleanup = await discard();
		await report({ ok: false, applied: false, error: "another project was opened while the draft's assets were loading; nothing was applied" + cleanupNote(cleanup), rolledBack: !cleanup?.failed.length, ...(cleanup ? { cleanup } : {}), results: ops.map((op) => ({ op: op?.op, ...opLabel(op), ok: false, skipped: true })) });
		return;
	}
	const root = agentRootScene();
	if (failures.some(Boolean) || !root) {
		const cleanup = await discard();
		const count = failures.filter(Boolean).length;
		const results = ops.map((op, i) => ({ op: op?.op, ...opLabel(op), ok: false, ...(failures[i] ? { error: failures[i] } : { skipped: true, error: "not applied: assets of another op failed to load" }) }));
		const error = (root ? "assets failed to load; nothing was applied" : "no scene") + cleanupNote(cleanup);
		toast.error(`Agent draft not applied: ${draft.label ?? draft.rev}`, {
			description: (root ? `${count} ${count === 1 ? "op" : "ops"} could not load assets; nothing changed (see draft-result.json)` : "No scene is open") + cleanupNote(cleanup),
		});
		await report({ ...(root ? { sceneId: root.id } : {}), ok: false, applied: false, error, rolledBack: !cleanup?.failed.length, ...(cleanup ? { cleanup } : {}), results });
		return;
	}


	// Read the scenes after loading: the human may have edited meanwhile.
	const before = editor.scenes.getScenes();
	const openScene = editor.scenes.getActiveScene();
	const outcome = computeAgentDraft({
		scenes: before, rootSceneId: root.id, ops, mediaFor: (e) => media.get(e), atomic: draft.atomic === true,
		canvas: project.settings.canvasSize, fps: project.settings.fps, ripple: editor.command.isRippleEnabled,
	});
	// The open scene stays open unless the draft removed it (ungrouping the compound being edited): then the root opens.
	const openAfter = outcome.scenes.some((scene) => scene.id === openScene.id) ? openScene.id : root.id;
	// Select changed or added items so they are visible on the timeline (inside history, so redo selects them again).
	const selection = selectionInScene(outcome.scenes, openAfter, outcome.touched);
	let error: string | null = outcome.applied ? null : "an op of this atomic draft failed; nothing was applied";
	// Media reused by `mediaId` must still be in the project (the human may have deleted it while assets loaded).
	const present = new Set(editor.media.getAssets().map((asset) => asset.id));
	const gone = [...media.entries()].filter(([e, loaded]) => e.mediaId !== undefined && !present.has(loaded.id)).map(([e]) => e.mediaId);
	if (!error && gone.length) error = `media no longer in the project: ${gone.join(", ")}; nothing was applied`;
	// Staged imports the result uses; the others (only used by failed ops) are removed.
	const used = usedMediaIds(outcome.scenes);
	const publish = staged.filter((id) => used.has(id));
	if (!error) {
		try {
			const command = new AgentDraftCommand({ before, after: outcome.scenes, selection, openBefore: openScene.id, openAfter, wrap: (action) => (editLogger ? editLogger.agent(action) : action()) });
			// Published in the same task as the commit (no await in between), so nothing else can
			// pick them up first, and the timeline never shows clips without their media.
			editor.media.publishStagedMediaAssets({ ids: publish });
			try {
				if (command.getChangedSceneIds().length) editor.command.execute({ command });
			} catch (e) {
				editor.media.unpublishMediaAssets({ projectId, ids: publish });
				throw e;
			}
		} catch (e) {
			error = errorText(e);
		}
	}
	if (error) {
		const cleanup = await discard();
		toast.error(`Agent draft not applied: ${draft.label ?? draft.rev}`, { description: error + cleanupNote(cleanup) });
		await report({ sceneId: root.id, ok: false, applied: false, error: error + cleanupNote(cleanup), rolledBack: !cleanup?.failed.length, ...(cleanup ? { cleanup } : {}), results: outcome.results });
		return;
	}
	const cleanup = await discard(new Set(publish));

	// Report where `url` and `sfx` assets were saved and their sources (for credits and reuse as `path`).
	for (const [i, op] of ops.entries()) {
		const retrieved = elementsOfOp(i).flatMap((e) => media.get(e)?.retrieved ?? []);
		const sfx = elementsOfOp(i).flatMap((e) => media.get(e)?.sfx ?? []);
		const music = elementsOfOp(i).flatMap((e) => media.get(e)?.music ?? []);
		if (outcome.results[i] && (retrieved.length || sfx.length || music.length)) {
			outcome.results[i] = { ...outcome.results[i], ...(retrieved.length ? { retrieved } : {}), ...(sfx.length ? { sfx } : {}), ...(music.length ? { music } : {}) };
		}
	}

	// The result is written once the change is on disk. The commit marks the project dirty even if
	// saving is paused, so a paused save is reported as not saved instead of passing silently.
	editor.save.markDirty({ force: true });
	const saved = await editor.save.settle();
	// Promoted only once the timeline that uses them is on disk: before that, another tab loading the
	// project would see media its saved timeline does not use yet.
	if (saved) {
		const promoteError = await editor.media.promotePublishedMediaAssets({ projectId, ids: publish });
		if (promoteError) console.warn("Staged media not promoted (they still load because the timeline uses them):", promoteError);
	}
	const failed = outcome.results.filter((r) => !r?.ok).length;
	const description = `${outcome.results.length - failed} changes${failed ? `, ${failed} failed` : ""} · changed items selected · Ctrl+Z to undo`;
	// Save state of this draft's project, not of whatever project is open by now.
	const saveError = saved ? null : (editor.save.getLastError(projectId) ?? (editor.save.getIsPaused() ? "saving is paused (a project is opening)" : "save did not finish"));
	if (!saved) toast.error(`Agent draft applied but not saved: ${draft.label ?? draft.rev}`, { description: saveError ?? undefined });
	else if (failed) toast.warning(`Agent draft partly applied: ${draft.label ?? draft.rev}`, { description });
	else toast(`Agent draft applied: ${draft.label ?? draft.rev}`, { description });
	await report({ sceneId: root.id, applied: true, saved, savedAt: editor.save.getLastSavedAt(projectId)?.toISOString() ?? null, ...(saved ? {} : { saveError }), ...(cleanup ? { cleanup } : {}), results: outcome.results });
}
