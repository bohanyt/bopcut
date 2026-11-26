// selection.json: what the user points at in the editor. The editor posts it; the server validates it and
// writes only the known fields, with its own timestamp.

export type SelectionFile = {
	projectId: string | null;
	sceneId: string | null;
	activeSceneId: string | null;
	playhead: number | null;
	selected: Record<string, unknown>[];
	truncated?: true;
	updatedAt: string;
};

/** The selection written when no project is open, so an agent never acts on a closed project's selection. */
export const NO_SELECTION = { projectId: null, sceneId: null, activeSceneId: null, playhead: null, selected: [] };

export const MAX_SELECTED = 5000;
export const MAX_SELECTION_BYTES = 4 * 1024 * 1024;

/** Keep the largest prefix that the server can store, with space for the truncation marker. */
export function boundSelectionPayload<T extends { selected: unknown[] }>(payload: T): T & { truncated?: true } {
	const encoder = new TextEncoder();
	const header = JSON.stringify({ ...payload, selected: [], truncated: true });
	let remaining = MAX_SELECTION_BYTES - encoder.encode(header).byteLength;
	let count = 0;
	while (count < Math.min(payload.selected.length, MAX_SELECTED)) {
		const item = JSON.stringify(payload.selected[count]);
		if (item.length > remaining) break;
		remaining -= encoder.encode(item).byteLength + (count > 0 ? 1 : 0);
		if (remaining < 0) break;
		count++;
	}
	return count === payload.selected.length ? payload : { ...payload, selected: payload.selected.slice(0, count), truncated: true };
}

const idOrNull = (value: unknown) => value === null || (typeof value === "string" && value.length > 0 && value.length <= 200);

/** The file to write for a posted selection, or null when the payload is not a valid selection. */
export function parseSelectionPayload(body: unknown, now = new Date()): SelectionFile | null {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const b = body as Record<string, unknown>;
	if (!idOrNull(b.projectId) || !idOrNull(b.sceneId) || !idOrNull(b.activeSceneId)) return null;
	if (!(b.playhead === null || (typeof b.playhead === "number" && Number.isFinite(b.playhead) && b.playhead >= 0))) return null;
	if (!Array.isArray(b.selected) || b.selected.length > MAX_SELECTED) return null;
	if (!b.selected.every((e) => e && typeof e === "object" && !Array.isArray(e) && typeof (e as { id?: unknown }).id === "string")) return null;
	// Without a project there is nothing to point at.
	if (b.projectId === null && (b.selected.length > 0 || b.playhead !== null)) return null;
	return {
		projectId: b.projectId as string | null,
		sceneId: b.sceneId as string | null,
		activeSceneId: b.activeSceneId as string | null,
		playhead: b.playhead as number | null,
		selected: b.selected as Record<string, unknown>[],
		...(b.projectId !== null && b.truncated === true && { truncated: true }),
		updatedAt: now.toISOString(),
	};
}
