// What changed between two timeline states, as values: every element added, deleted or changed (timing,
// trims, track, params, keyframes, text), inside compound clips too. Used for `changes-request.json`.
import { type EditLine, diffEdits } from "./edit-log";
import { draftHistory, resolveState, snapshotHistory, type TimelineState } from "./history";
import { buildEditItems } from "./snapshot";

/** One change: like an edit log line, without who made it (`agentMade` says whether the item is the agent's). */
export type Change = Omit<EditLine, "t" | "actor">;

export function changesBetween({ before, after, mediaName }: { before: TimelineState; after: TimelineState; mediaName: Map<string, string> }): Change[] {
	const items = (state: TimelineState) => ({ projectId: state.projectId, items: buildEditItems({ scenes: state.scenes, rootSceneId: state.rootSceneId, mediaName }) });
	return diffEdits(items(before), items(after)).map(({ t: _t, actor: _actor, ...change }) => change);
}

export type ChangesRequest = { rev: string; since?: unknown; draft?: unknown };

/**
 * Answers a changes request against the timeline as it is now (`now`): since a snapshot (`since`, its
 * `syncedAt`), or for a draft (`draft`, its rev): what the draft changed and what changed after it. The
 * answer records the current state as a snapshot too, so its `syncedAt` can be the next `since` or
 * `basedOn`.
 */
export function changesResult(request: ChangesRequest, { now, mediaName, at = new Date().toISOString() }: { now: TimelineState; mediaName: Map<string, string>; at?: string }) {
	const head = { rev: request.rev, projectId: now.projectId, syncedAt: at };
	snapshotHistory.record(at, now.scenes, { projectId: now.projectId, rootSceneId: now.rootSceneId });
	if (typeof request.draft === "string") {
		const draft = draftHistory.get(request.draft);
		if (!draft || draft.before.projectId !== now.projectId) {
			return { ...head, draft: request.draft, error: resolveState({ draft: request.draft, side: "after" }, now.projectId) as string };
		}
		return {
			...head,
			draft: request.draft,
			draftChanges: changesBetween({ before: draft.before, after: draft.after, mediaName }),
			changes: changesBetween({ before: draft.after, after: now, mediaName }),
		};
	}
	if (typeof request.since === "string") {
		const then = resolveState({ syncedAt: request.since }, now.projectId);
		if (typeof then === "string") return { ...head, since: request.since, error: then };
		return { ...head, since: request.since, changes: changesBetween({ before: then, after: now, mediaName }) };
	}
	return { ...head, error: "a changes request needs since (a snapshot's syncedAt) or draft (a draft rev)" };
}
