// Diff completed snapshots, not every drag frame.
// Items cover every scene under the root timeline (compound clip contents included): `sceneId` +
// `path` (compound clip ids from the root) say where an element is; `rootStart`/`rootEnd` say where
// it shows on the root timeline, so grouping (which rewrites local times and tracks) is not
// mistaken for retiming.
export type EditItem = {
	id: string; agentId: string | null; name: string; media: string | null; type: string; track: string; trackId?: string; caption?: unknown;
	sceneId: string; path: string[]; contentSceneId?: string;
	startTime: number; duration: number; trimStart: number; trimEnd: number; rootStart?: number; rootEnd?: number;
	params: Record<string, unknown>; animations: Record<string, unknown>;
};
export type EditSnapshot = { projectId: string; items: EditItem[] };
/** `agentMade`: the item was made by an agent (it has an agentId); every element is logged either way. */
export type EditLine = { t: string; projectId: string; actor: "user"; kind: "set" | "delete" | "add"; agentId: string | null; agentMade: boolean; elementId: string; name: string; track: string; sceneId: string; path: string[]; elementType: string; field: string; from: unknown; to: unknown };

const keyOf = (item: EditItem) => `${item.sceneId}\u0000${item.id}`;

/**
 * `structural`: also report the compound clip a group creates (or an ungroup removes), which the edit
 * log leaves out because it only wraps moved elements.
 */
export function diffEdits(before: EditSnapshot | null, after: EditSnapshot, t = new Date().toISOString(), { structural = false }: { structural?: boolean } = {}): EditLine[] {
	if (!before || before.projectId !== after.projectId) return [];
	const old = new Map(before.items.map((item) => [keyOf(item), item]));
	const next = new Map(after.items.map((item) => [keyOf(item), item]));
	// Grouping or ungrouping moves an element to another scene with the same id: one item, a `sceneId` change.
	const gone = new Map(before.items.filter((item) => !next.has(keyOf(item))).map((item) => [item.id, item]));
	const moved = new Map<string, EditItem>();
	for (const item of after.items) {
		const prev = old.has(keyOf(item)) ? undefined : gone.get(item.id);
		if (prev) { moved.set(keyOf(item), prev); gone.delete(item.id); }
	}
	// The compound clip a group creates (or an ungroup removes) only wraps moved elements: structural, not an add/delete.
	const movedIn = new Set([...moved.keys()].map((key) => next.get(key)?.sceneId));
	const movedOut = new Set([...moved.values()].map((item) => item.sceneId));
	const sceneIds = (snapshot: EditSnapshot) => new Set(snapshot.items.map((item) => item.sceneId));
	const beforeScenes = sceneIds(before);
	const afterScenes = sceneIds(after);
	const wrapsMoved = (item: EditItem, scenes: Set<string>, other: Set<string>, sides: Set<string | undefined>) =>
		item.type === "compound" && !!item.contentSceneId && !other.has(item.contentSceneId) && sides.has(item.contentSceneId) && scenes.has(item.contentSceneId);

	const lines: EditLine[] = [];
	const add = (item: EditItem, kind: EditLine["kind"], field: string, from: unknown, to: unknown) => {
		// Unchanged values are usually the same object (elements are replaced, not mutated): no serializing.
		if (from === to || JSON.stringify(from) === JSON.stringify(to)) return;
		lines.push({ t, projectId: after.projectId, actor: "user", kind, agentId: item.agentId, agentMade: item.agentId !== null, elementId: item.id, name: item.media ?? item.name, track: item.track, sceneId: item.sceneId, path: item.path, elementType: item.type, field, from: from ?? null, to: to ?? null });
	};
	// What an added or deleted element was: timing, text and other params, keyframes, caption data.
	const whole = (item: EditItem) => ({
		startTime: item.startTime, duration: item.duration, params: item.params,
		...(Object.keys(item.animations).length ? { keyframes: item.animations } : {}),
		...(item.caption !== undefined ? { caption: item.caption } : {}),
	});
	for (const item of gone.values()) {
		if (!structural && wrapsMoved(item, beforeScenes, afterScenes, movedOut)) continue;
		add(item, "delete", "element", whole(item), null);
	}
	for (const item of after.items) {
		const prev = old.get(keyOf(item)) ?? moved.get(keyOf(item));
		if (!prev) {
			if (structural || !wrapsMoved(item, afterScenes, beforeScenes, movedIn)) add(item, "add", "element", null, whole(item));
			continue;
		}
		if (prev.sceneId !== item.sceneId) {
			// Moved between scenes: local times, trims, and the track are remapped by the move itself.
			// Only a change of where it shows on the root timeline is a timing edit (in root seconds).
			add(item, "set", "sceneId", prev.sceneId, item.sceneId);
			if (prev.rootStart !== undefined && item.rootStart !== undefined) add(item, "set", "startTime", prev.rootStart, item.rootStart);
			if (prev.rootStart !== undefined && prev.rootEnd !== undefined && item.rootStart !== undefined && item.rootEnd !== undefined) {
				add(item, "set", "duration", round(prev.rootEnd - prev.rootStart), round(item.rootEnd - item.rootStart));
			}
		} else {
			for (const field of ["startTime", "duration", "trimStart", "trimEnd", "track", "trackId"] as const) {
				// A compound clip's trimEnd follows its content's length (see syncCompoundDurations), so it is not a human edit.
				if (field === "trimEnd" && item.type === "compound") continue;
				add(item, "set", field, prev[field], item[field]);
			}
		}
		for (const key of new Set([...Object.keys(prev.params), ...Object.keys(item.params)])) add(item, "set", key, prev.params[key], item.params[key]);
		add(item, "set", "caption", prev.caption, item.caption);
		for (const key of new Set([...Object.keys(prev.animations), ...Object.keys(item.animations)])) add(item, "set", `keyframes.${key}`, prev.animations[key], item.animations[key]);
	}
	return lines;
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

export function createEditLogger(capture: () => EditSnapshot | null, preview: () => boolean, send: (lines: EditLine[]) => void) {
	let baseline = capture();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let suppressed = false;
	const settle = () => {
		if (suppressed) return;
		if (preview()) { timer = setTimeout(settle, 800); return; }
		const current = capture();
		if (current) { const lines = diffEdits(baseline, current); baseline = current; if (lines.length) send(lines); }
		else baseline = null;
	};
	return {
		stop() { clearTimeout(timer); if (!preview()) settle(); },
		changed() { if (!suppressed) { clearTimeout(timer); timer = setTimeout(settle, 800); } },
		agent(action: () => void) { clearTimeout(timer); settle(); suppressed = true; try { action(); } finally { baseline = capture(); suppressed = false; } },
	};
}
