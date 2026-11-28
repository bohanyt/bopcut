import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWrite, projectDir, readJson } from "@/services/storage/server/files";
import type { HiddenEditorState } from "./hidden-editor";
import { fileInside } from "./inside";

/**
 * Draft tools of the MCP server. They use the file protocol of AGENT.md: the draft goes to draft.json,
 * the open editor applies it as one Undo step and writes draft-result.json.
 */

type Args = Record<string, unknown>;
export type DraftContext = {
	workspace: string;
	signal: AbortSignal;
	/** Whether an editor tab of the project answered in the last few seconds. */
	editorOpen: (projectId: string) => Promise<boolean>;
	/** How long submit_draft waits for the open editor, and get_draft_result by default. */
	waitMs: number;
	/** Opens the project in the hidden editor when no tab has it open; null leaves the draft waiting for a tab. */
	openHidden?: ((projectId: string) => Promise<HiddenEditorState>) | null;
};
type Outcome = { value: Record<string, unknown>; isError?: boolean };
type Replaced = { rev: string; projectId: string | null };

export const MAX_DRAFT_OPS = 10_000;
export const MAX_DRAFT_WAIT_SECONDS = 50;
/** The editor looks for a draft every 2 s. */
const CHECK_MS = 500;

/** A workspace file as JSON, or null when it is missing or half written. A link out of the workspace fails. */
async function readWorkspaceJson(workspace: string, name: string): Promise<Record<string, unknown> | null> {
	const file = await fileInside(workspace, name);
	if (!file) return null;
	try {
		const value = await readJson(file);
		return value && typeof value === "object" ? value : null;
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

function checkDraft(args: Args) {
	const { ops, label, basedOn, atomic, onConflict } = args;
	if (!Array.isArray(ops) || !ops.length || ops.length > MAX_DRAFT_OPS ||
		ops.some((op) => !op || typeof op !== "object" || Array.isArray(op) || typeof (op as Args).op !== "string")) {
		throw new Error(`Pass ops as a list of 1 to ${MAX_DRAFT_OPS} draft ops, each with its "op".`);
	}
	if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 200)) {
		throw new Error("Pass label as a short name of up to 200 characters.");
	}
	if (basedOn !== undefined && (typeof basedOn !== "string" || !basedOn.trim())) {
		throw new Error("Pass basedOn as the syncedAt of the snapshot from get_status.");
	}
	if (atomic !== undefined && typeof atomic !== "boolean") throw new Error("Pass atomic as true or false.");
	if (onConflict !== undefined && onConflict !== "keep" && onConflict !== "refuse") throw new Error("Pass onConflict as keep or refuse.");
	return {
		...(typeof label === "string" && { label: label.trim() }),
		...(basedOn !== undefined && { basedOn }),
		...(atomic !== undefined && { atomic }),
		...(onConflict !== undefined && { onConflict }),
		ops,
	};
}

/**
 * The draft that has not applied yet goes to drafts-applied/ as superseded, as when the editor finds
 * a newer draft in its place, so it can still be read.
 */
async function setAsidePending(workspace: string): Promise<Replaced | undefined> {
	const pending = await readWorkspaceJson(workspace, "draft.json");
	if (!pending) return undefined;
	const dir = path.join(workspace, "drafts-applied");
	await fs.mkdir(dir, { recursive: true });
	try {
		await fs.rename(path.join(workspace, "draft.json"), path.join(dir, `superseded-${Date.now()}-${randomUUID().slice(0, 8)}.json`));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	return { rev: String(pending.rev ?? ""), projectId: typeof pending.projectId === "string" ? pending.projectId : null };
}

export async function submitDraft(args: Args, projectId: string, context: DraftContext): Promise<Outcome> {
	await fs.access(path.join(projectDir(projectId), "project.json")).catch(() => {
		throw new Error("Project was not found on disk. Pass a projectId from list_projects.");
	});
	const fields = checkDraft(args);
	const rev = `mcp-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
	const replaced = await setAsidePending(context.workspace);
	await atomicWrite(path.join(context.workspace, "draft.json"),
		JSON.stringify({ schema: "opencut-agent-draft-1", rev, projectId, ...fields }), context.signal);
	return draftStatus({ rev, projectId, waitMs: context.waitMs, replaced }, context);
}

export function draftResult(args: Args, projectId: string, context: DraftContext): Promise<Outcome> {
	const { rev, waitSeconds } = args;
	if (typeof rev !== "string" || !/^[\w-]{1,128}$/.test(rev)) throw new Error("Pass the rev that submit_draft returned.");
	if (waitSeconds !== undefined && (typeof waitSeconds !== "number" || !(waitSeconds >= 0 && waitSeconds <= MAX_DRAFT_WAIT_SECONDS))) {
		throw new Error(`Pass waitSeconds from 0 to ${MAX_DRAFT_WAIT_SECONDS}.`);
	}
	return draftStatus({ rev, projectId, waitMs: waitSeconds === undefined ? context.waitMs : waitSeconds * 1000 }, context);
}

/** The editor's result once it is there; until then, while the project is open, checks again until the wait ends. */
async function draftStatus({ rev, projectId, waitMs, replaced }: { rev: string; projectId: string; waitMs: number; replaced?: Replaced },
	context: DraftContext): Promise<Outcome> {
	const deadline = Date.now() + waitMs;
	const extra = replaced ? { replacedDraft: replaced } : {};
	let open: boolean | undefined;
	let hidden: HiddenEditorState | undefined;
	let missing = false;
	for (;;) {
		const result = await readWorkspaceJson(context.workspace, "draft-result.json");
		if (result?.rev === rev) {
			if (result.projectId !== undefined && result.projectId !== projectId) {
				throw new Error(`Draft ${rev} belongs to project ${String(result.projectId)}.`);
			}
			return answered(rev, projectId, result, hidden ? { ...extra, hiddenEditor: hidden } : extra);
		}
		const pending = await readWorkspaceJson(context.workspace, "draft.json");
		if (pending?.rev === rev) {
			if (pending.projectId !== projectId) throw new Error(`Draft ${rev} belongs to project ${String(pending.projectId)}.`);
			missing = false;
			open ??= await context.editorOpen(projectId);
			if (!open && !hidden && context.openHidden) {
				hidden = await context.openHidden(projectId).catch((error) => {
					console.error("[agent] Could not open the hidden editor:", error);
					return undefined;
				});
			}
			const loading = !open && (hidden === "opened" || hidden === "running");
			if ((!open && !loading) || Date.now() >= deadline) {
				return waiting(rev, projectId, open, waitMs, hidden ? { ...extra, hiddenEditor: hidden } : extra);
			}
		} else if (missing) {
			// Gone from draft.json without a result of its own, also after the editor had time to write one.
			throw new Error(`Draft ${rev} is not waiting in draft.json, and draft-result.json holds another draft's result. ` +
				"A newer draft replaced it (see drafts-applied/superseded-*.json), or a later draft's result replaced its own.");
		} else {
			// The editor moves the draft away just before it writes the result.
			missing = true;
		}
		await sleep(CHECK_MS, undefined, { signal: context.signal });
	}
}

function answered(rev: string, projectId: string, result: Record<string, unknown>, extra: Args): Outcome {
	const applied = result.applied === true;
	const saved = result.saved === true;
	const message = applied
		? `Draft ${rev} applied as one Undo step${saved ? " and was saved" : `; the project is not saved yet${result.saveError ? `: ${String(result.saveError)}` : ""}`}.`
		: `Draft ${rev} was not applied${result.error ? `: ${String(result.error)}` : ""}.${result.stale ? " Read get_status again and send a new draft." : ""}`;
	return { value: { rev, projectId, answered: true, applied, message, ...extra, result }, isError: !applied };
}

function waiting(rev: string, projectId: string, open: boolean, waitMs: number, extra: Args): Outcome {
	const hidden = extra.hiddenEditor;
	const message = open
		? `Draft ${rev} has not applied after ${Math.round(waitMs / 1000)} s. The editor waits while media load, a save is pending ` +
			"or the person drags on the timeline. Call get_draft_result again."
		: hidden === "opened" || hidden === "running"
			? `Draft ${rev} has not applied yet: no editor tab had project ${projectId} open, so a hidden editor ` +
				`${hidden === "opened" ? "is loading" : "has"} the saved project and applies the draft there (a project with much media ` +
				"takes longer to load). Call get_draft_result again."
			: hidden === "busy"
				? `Draft ${rev} waits in draft.json: no editor tab of project ${projectId} is open, and the hidden editor is still busy ` +
					"with another project's draft. Call get_draft_result again in a moment."
				: `Draft ${rev} waits in draft.json: no editor tab of project ${projectId} answered in the last few seconds, and drafts ` +
					"apply only in an open editor. Ask the person to open the project in the editor (a tab in the background can take " +
					"a minute), then call get_draft_result.";
	return { value: { rev, projectId, answered: false, editorOpen: open, message, ...extra } };
}
