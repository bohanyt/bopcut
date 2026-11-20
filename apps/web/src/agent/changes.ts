// What changed between two timeline states, as values: every element added, deleted or changed (timing,
// trims, track, params, keyframes, caption data), inside compound clips too. Used for `changes-request.json`.
import { type EditLine, type EditSnapshot, diffEdits } from "./edit-log";
import { draftHistory, isOtherProjects, resolveState, snapshotHistory, type TimelineState } from "./history";
import { buildAllEditItems } from "./snapshot";

/** One change: like an edit log line, without who made it (`agentMade` says whether the item is the agent's). */
export type Change = Omit<EditLine, "t" | "actor">;

/** At most this many changes in one answer (the rest is cut, with `truncated: true`). */
export const MAX_CHANGES = 5000;

/** Every element under every root scene of a state (switching the open scene is not a change). */
function itemsOf(state: TimelineState, mediaName: Map<string, string>): EditSnapshot {
	return { projectId: state.projectId, items: buildAllEditItems({ scenes: state.scenes, mediaName }) };
}

function between(before: EditSnapshot, after: EditSnapshot): Change[] {
	// Structural: the compound clip a group creates (or an ungroup removes) is reported too.
	return diffEdits(before, after, undefined, { structural: true }).map(({ t: _t, actor: _actor, ...change }) => change);
}

export function changesBetween({ before, after, mediaName }: { before: TimelineState; after: TimelineState; mediaName: Map<string, string> }): Change[] {
	return between(itemsOf(before, mediaName), itemsOf(after, mediaName));
}

const capped = (changes: Change[]) => (changes.length > MAX_CHANGES ? { changes: changes.slice(0, MAX_CHANGES), truncated: true } : { changes });

export type ChangesRequest = { rev: string; projectId?: unknown; since?: unknown; draft?: unknown };

/**
 * The state of an answer, kept as a snapshot so its `syncedAt` can be the next `since` or `basedOn`. Call
 * it once the answer is stored: a failed one must not push an older base out of the history.
 */
export function keepAnswerState(now: TimelineState, at: string): void {
	snapshotHistory.record(at, now.scenes, { projectId: now.projectId, rootSceneId: now.rootSceneId, settings: now.settings, media: now.media });
}

/**
 * Answers a changes request against the timeline as it is now (`now`): since a snapshot (`since`, its
 * `syncedAt`), or for a draft (`draft`, its rev): what the draft changed and what changed after it. An
 * answer carries `syncedAt` (`at`); keep its state with keepAnswerState once it is stored. Null when the
 * request is for another project (it is left for that one).
 */
export function changesResult(request: ChangesRequest, { now, mediaName, at = new Date().toISOString() }: { now: TimelineState; mediaName: Map<string, string>; at?: string }) {
	if (typeof request.projectId === "string" && request.projectId !== now.projectId) return null;
	const head = { rev: request.rev, projectId: now.projectId };
	const answered = <T extends object>(body: T) => ({ ...head, syncedAt: at, ...body });
	if (typeof request.draft === "string") {
		if (isOtherProjects({ draft: request.draft, side: "after" }, now.projectId)) return null;
		const draft = draftHistory.get(now.projectId, request.draft);
		if (!draft) return { ...head, draft: request.draft, error: resolveState({ draft: request.draft, side: "after" }, now.projectId) as string };
		const after = itemsOf(draft.after, mediaName);
		const drafted = capped(between(itemsOf(draft.before, mediaName), after));
		const later = capped(between(after, itemsOf(now, mediaName)));
		return answered({
			draft: request.draft,
			draftChanges: drafted.changes, ...(drafted.truncated ? { draftTruncated: true } : {}),
			changes: later.changes, ...(later.truncated ? { truncated: true } : {}),
		});
	}
	if (typeof request.since === "string") {
		if (isOtherProjects({ syncedAt: request.since }, now.projectId)) return null;
		const then = resolveState({ syncedAt: request.since }, now.projectId);
		if (typeof then === "string") return { ...head, since: request.since, error: then };
		return answered({ since: request.since, ...capped(changesBetween({ before: then, after: now, mediaName })) });
	}
	return { ...head, error: "a changes request needs since (a snapshot's syncedAt) or draft (a draft rev)" };
}
