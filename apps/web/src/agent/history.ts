// Past timeline states an agent can refer to: the state each snapshot showed (by its `syncedAt`) and
// the states just before and after each draft (by its `rev`). Both are kept by reference: elements are
// replaced, not mutated, on every edit, so a past state shares everything that has not changed since.
import type { TScene } from "@/timeline";
import type { TProjectSettings } from "@/project/types";
import { SnapshotHistory } from "./stale";

/**
 * A timeline state: its scenes and root, the project settings it was rendered with, and the names of the
 * media it could use (so a frame of it can say which of them were removed since, instead of leaving them out).
 */
export type TimelineState = {
	projectId: string; scenes: TScene[]; rootSceneId: string;
	settings?: Pick<TProjectSettings, "canvasSize" | "background" | "fps">; media?: Map<string, string>;
};
/** A past state: the one a snapshot showed, or the one just before or after a draft applied. */
export type StateRef = { syncedAt: string } | { draft: string; side: "before" | "after" };

/** Snapshots sent to the agent (also those taken in the console), for `basedOn`, `since` and frames. */
export const snapshotHistory = new SnapshotHistory(64, (scenes) => withoutBuffers(scenes));

/**
 * Scenes without decoded audio: a library sound carries its AudioBuffer, which a kept state must not hold
 * on to after the sound is removed. Only those elements are copied; everything else is shared.
 */
export function withoutBuffers(scenes: TScene[]): TScene[] {
	let changed = false;
	const out = scenes.map((scene) => {
		const strip = <T extends { elements: unknown[] }>(track: T): T => {
			if (!track.elements.some((e) => (e as { buffer?: unknown }).buffer !== undefined)) return track;
			changed = true;
			return { ...track, elements: track.elements.map((e) => ((e as { buffer?: unknown }).buffer !== undefined ? { ...(e as object), buffer: undefined } : e)) };
		};
		const audio = scene.tracks.audio.map(strip);
		if (audio.every((track, i) => track === scene.tracks.audio[i])) return scene;
		return { ...scene, tracks: { ...scene.tracks, audio } };
	});
	return changed ? out : scenes;
}

/** The last drafts applied in this editor session, per project: the timeline just before and after each. */
class DraftHistory {
	private entries: { rev: string; before: TimelineState; after: TimelineState }[] = [];
	/** `size` per project; `total` across projects. */
	constructor(private readonly size = 16, private readonly total = 64) {}
	record(rev: string, before: TimelineState, after: TimelineState) {
		const projectId = before.projectId;
		this.entries = this.entries.filter((entry) => !(entry.rev === rev && entry.before.projectId === projectId));
		this.entries.push({ rev, before: { ...before, scenes: withoutBuffers(before.scenes) }, after: { ...after, scenes: withoutBuffers(after.scenes) } });
		const own = this.entries.filter((entry) => entry.before.projectId === projectId);
		if (own.length > this.size) this.entries.splice(this.entries.indexOf(own[0]), 1);
		if (this.entries.length > this.total) this.entries.shift();
	}
	get(projectId: string, rev: string) {
		return this.entries.find((entry) => entry.rev === rev && entry.before.projectId === projectId);
	}
	/** A draft of that rev was applied in another project (a request meant for it, not this one). */
	elsewhere(projectId: string, rev: string): boolean {
		return this.entries.some((entry) => entry.rev === rev && entry.before.projectId !== projectId);
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

/** The reference names a state of another project: the request is not for the open one. */
export function isOtherProjects(ref: StateRef, projectId: string): boolean {
	if ("syncedAt" in ref) {
		const state = snapshotHistory.state(ref.syncedAt);
		return !!state && state.projectId !== projectId;
	}
	return !draftHistory.get(projectId, ref.draft) && draftHistory.elsewhere(projectId, ref.draft);
}

/** The state a reference names, for the open project; a message saying why not otherwise. */
export function resolveState(ref: StateRef, projectId: string): TimelineState | string {
	if ("syncedAt" in ref) {
		const state = snapshotHistory.state(ref.syncedAt);
		if (!state || state.projectId !== projectId) return `unknown syncedAt ${ref.syncedAt} (the editor reloaded, the snapshot is too old, or it is of another project); use a newer snapshot`;
		return state as TimelineState;
	}
	const draft = draftHistory.get(projectId, ref.draft);
	if (!draft) return `unknown draft ${ref.draft} (not applied in this editor session, too old, or of another project)`;
	return ref.side === "before" ? draft.before : draft.after;
}
