// Past timeline states an agent can refer to: the state each snapshot showed (by its `syncedAt`) and
// the states just before and after each draft (by its `rev`). Both are kept by reference: elements are
// replaced, not mutated, on every edit, so a past state shares everything that has not changed since.
import type { TScene } from "@/timeline";
import { SnapshotHistory } from "./stale";

export type TimelineState = { projectId: string; scenes: TScene[]; rootSceneId: string };
/** A past state: the one a snapshot showed, or the one just before or after a draft applied. */
export type StateRef = { syncedAt: string } | { draft: string; side: "before" | "after" };

/** Snapshots sent to the agent (also those taken in the console), for `basedOn`, `since` and frames. */
export const snapshotHistory = new SnapshotHistory();

/** The last drafts applied in this editor session: the timeline just before and just after each. */
class DraftHistory {
	private entries: { rev: string; before: TimelineState; after: TimelineState }[] = [];
	constructor(private readonly size = 16) {}
	record(rev: string, before: TimelineState, after: TimelineState) {
		this.entries = this.entries.filter((entry) => entry.rev !== rev);
		this.entries.push({ rev, before, after });
		if (this.entries.length > this.size) this.entries.shift();
	}
	get(rev: string) {
		return this.entries.find((entry) => entry.rev === rev);
	}
}
export const draftHistory = new DraftHistory();

/** A state reference from a request, or null when it is malformed. */
export function parseStateRef(value: unknown): StateRef | null {
	if (!value || typeof value !== "object") return null;
	const ref = value as { syncedAt?: unknown; draft?: unknown; side?: unknown };
	if (typeof ref.syncedAt === "string") return { syncedAt: ref.syncedAt };
	if (typeof ref.draft === "string" && (ref.side === "before" || ref.side === "after")) return { draft: ref.draft, side: ref.side };
	return null;
}

/** The state a reference names, for the open project; a message saying why not otherwise. */
export function resolveState(ref: StateRef, projectId: string): TimelineState | string {
	if ("syncedAt" in ref) {
		const state = snapshotHistory.state(ref.syncedAt);
		if (!state || state.projectId !== projectId) return `unknown syncedAt ${ref.syncedAt} (the editor reloaded, the snapshot is too old, or it is of another project); use a newer snapshot`;
		return state;
	}
	const draft = draftHistory.get(ref.draft);
	if (!draft || draft.before.projectId !== projectId) return `unknown draft ${ref.draft} (not applied in this editor session, too old, or of another project)`;
	return ref.side === "before" ? draft.before : draft.after;
}
