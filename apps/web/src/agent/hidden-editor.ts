import { promises as fs } from "node:fs";
import path from "node:path";
import { dataRoot, readJson } from "@/services/storage/server/files";
import { launchBrowser, type RunningBrowser } from "./hidden-browser";

/**
 * The editor in a hidden browser, for drafts sent while no tab has their project open: it loads the
 * saved project, applies the draft as an open tab would (one Undo step, then a save) and is closed
 * once nothing waits for it. One at a time, on a browser profile of its own (the render browser may
 * be running).
 */

/** How long it stays open with no draft waiting, for the agent's next draft. */
export const HIDDEN_EDITOR_IDLE_MS = 60_000;
/** The longest it stays open. */
export const HIDDEN_EDITOR_MAX_MS = 15 * 60_000;

export type HiddenEditorState = "opened" | "running" | "busy";
type Session = { projectId: string; browser: RunningBrowser; idle?: ReturnType<typeof setTimeout>; cap: ReturnType<typeof setTimeout> };

// Route modules can be separate copies: the open session is kept on the process.
const store = globalThis as typeof globalThis & { __bopcutHiddenEditor?: { session?: Session } };
const state = (store.__bopcutHiddenEditor ??= {});

/** Whether a draft of the project still waits in draft.json, or its result is not saved yet. */
async function stillNeeded(workspace: string, projectId: string) {
	const read = (name: string) => readJson(path.join(workspace, name)).catch(() => null) as Promise<Record<string, unknown> | null>;
	const pending = await read("draft.json");
	if (pending?.projectId === projectId) return true;
	const result = await read("draft-result.json");
	return result?.projectId === projectId && result.applied === true && result.saved !== true;
}

function stop(session: Session) {
	clearTimeout(session.idle);
	clearTimeout(session.cap);
	if (state.session === session) state.session = undefined;
	return session.browser.stop().catch(() => {});
}

function arm(session: Session, workspace: string, idleMs: number) {
	clearTimeout(session.idle);
	session.idle = setTimeout(async () => {
		if (state.session !== session) return;
		if (await stillNeeded(workspace, session.projectId).catch(() => false)) arm(session, workspace, idleMs);
		else void stop(session);
	}, idleMs);
}

/**
 * Opens the project in the hidden editor, or keeps the one already open for it. Another project's
 * hidden editor is closed first when nothing of it waits; otherwise the answer is "busy".
 */
export async function openHiddenEditor({ projectId, origin, workspace, launch = launchBrowser, profileRoot = dataRoot(),
	idleMs = HIDDEN_EDITOR_IDLE_MS, maxMs = HIDDEN_EDITOR_MAX_MS }: {
	projectId: string; origin: string; workspace: string;
	launch?: (url: string, profile: string) => RunningBrowser;
	profileRoot?: string; idleMs?: number; maxMs?: number;
}): Promise<HiddenEditorState> {
	const current = state.session;
	if (current?.projectId === projectId) {
		arm(current, workspace, idleMs);
		return "running";
	}
	if (current) {
		if (await stillNeeded(workspace, current.projectId)) return "busy";
		await stop(current);
	}
	const profile = path.join(profileRoot, ".draft-browser");
	await fs.mkdir(profile, { recursive: true });
	const browser = launch(new URL(`/editor/${encodeURIComponent(projectId)}`, origin).href, profile);
	const session: Session = { projectId, browser, cap: setTimeout(() => void stop(session), maxMs) };
	state.session = session;
	void browser.exited.then(() => {
		if (state.session === session) {
			clearTimeout(session.idle);
			clearTimeout(session.cap);
			state.session = undefined;
		}
	});
	arm(session, workspace, idleMs);
	return "opened";
}

/** The project the hidden editor has open, if any. */
export const hiddenEditorProject = () => state.session?.projectId;

/** Closes the hidden editor (tests, server shutdown). */
export async function closeHiddenEditor() {
	if (state.session) await stop(state.session);
}
