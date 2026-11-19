// Editing on top of the user's edits: a draft says which snapshot it was computed from (`basedOn`, the
// snapshot's `syncedAt`). A set/replace/delete whose target changed in a field the op touches after that
// snapshot is refused as stale, with the current values, so the agent re-reads and applies on top of them.
// Nothing is locked: ops on unchanged fields (and on elements the user did not touch) apply as usual.
//
// Every check compares the snapshot (`base`) with the timeline as it was before the draft (`now`), never
// with the draft's own intermediate state, so two ops of one draft never trip over each other.
import type { TimelineElement, TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { orderedTracks } from "./scene-graph";

/** The comparable state of one element: timing in seconds, each param and the keyframes as JSON. */
export type ElementFields = { start: number; duration: number; trimStart: number; params: Record<string, string>; animations: string; whole: string };

/** One element in a snapshot: its fields, the track it is on, and (compound clips) a digest of their content. */
export type ElementRecord = { fields: ElementFields; trackId: string; content: string | null };

const sec = (t: number) => Math.round((t / TICKS_PER_SECOND) * 1e6) / 1e6;

/** JSON with object keys sorted (array order kept), so equal values always give equal text. */
export function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, v) =>
		v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
			? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
			: v,
	) ?? "null";
}

/** A 53-bit digest of a string (cyrb53), to keep large compound contents out of the history. */
function digest(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Elements are replaced, not mutated, on every edit: an unchanged element keeps its object and its record.
const fieldsCache = new WeakMap<object, ElementFields>();

export function fieldsOf(element: TimelineElement): ElementFields {
	const cached = fieldsCache.get(element);
	if (cached) return cached;
	const params: Record<string, string> = {};
	for (const [key, value] of Object.entries(element.params ?? {})) params[key] = stableJson(value);
	const fields: ElementFields = {
		start: sec(element.startTime),
		duration: sec(element.duration),
		trimStart: sec(element.trimStart),
		params,
		animations: stableJson((element as { animations?: unknown }).animations ?? null),
		whole: digest(stableJson(element)),
	};
	fieldsCache.set(element, fields);
	return fields;
}

/** Digest of everything inside a compound clip: its content scene and the scenes nested in it. */
function contentOf(sceneId: string, scenes: Map<string, TScene>, seen = new Set<string>()): string {
	if (seen.has(sceneId)) return "cycle";
	seen.add(sceneId);
	const scene = scenes.get(sceneId);
	if (!scene) return "missing";
	const parts: string[] = [];
	for (const track of orderedTracks(scene.tracks)) {
		parts.push(`${track.id}:${stableJson({ ...track, elements: undefined })}`);
		for (const element of track.elements) {
			parts.push(fieldsOf(element).whole);
			const nested = (element as { sceneId?: unknown }).sceneId;
			if (element.type === "compound" && typeof nested === "string") parts.push(contentOf(nested, scenes, seen));
		}
	}
	return digest(parts.join("|"));
}

/** Every element of every scene, keyed `sceneId:elementId`. */
export function fieldsMapOf(scenes: TScene[]): Map<string, ElementRecord> {
	const byId = new Map(scenes.map((scene) => [scene.id, scene] as const));
	const map = new Map<string, ElementRecord>();
	for (const scene of scenes) {
		for (const track of orderedTracks(scene.tracks)) {
			for (const element of track.elements) {
				const nested = (element as { sceneId?: unknown }).sceneId;
				const content = element.type === "compound" && typeof nested === "string" ? contentOf(nested, byId) : null;
				map.set(`${scene.id}:${element.id}`, { fields: fieldsOf(element), trackId: track.id, content });
			}
		}
	}
	return map;
}

/** A bounded history of snapshots the editor sent, so a draft's `basedOn` can be compared with now. */
export class SnapshotHistory {
	private entries: { at: string; fields: Map<string, ElementRecord> }[] = [];
	constructor(private readonly size = 64) {}
	record(at: string, scenes: TScene[]) {
		this.entries = this.entries.filter((entry) => entry.at !== at);
		this.entries.push({ at, fields: fieldsMapOf(scenes) });
		if (this.entries.length > this.size) this.entries.shift();
	}
	get(at: string): Map<string, ElementRecord> | undefined {
		return this.entries.find((entry) => entry.at === at)?.fields;
	}
}

export class StaleError extends Error {
	constructor(readonly fields: string[], readonly current: Record<string, unknown>) {
		super(`stale: the user changed ${fields.join(", ")} after basedOn; re-read the snapshot and apply on top of the current values`);
	}
}

/** Fields a set op touches: timing it sets, each param key, and keyframes. */
export function touchedFields(op: { start?: unknown; duration?: unknown; trimStart?: unknown; params?: Record<string, unknown>; keyframes?: unknown; keyframesMode?: unknown }): string[] {
	const fields: string[] = [];
	if (op.start !== undefined) fields.push("start");
	if (op.duration !== undefined) fields.push("duration");
	if (op.trimStart !== undefined) fields.push("trimStart");
	for (const key of Object.keys(op.params ?? {})) fields.push(`params.${key}`);
	if (op.keyframes !== undefined || op.keyframesMode !== undefined) fields.push("keyframes");
	return fields;
}

function differs(field: string, then: ElementRecord, now: ElementRecord): boolean {
	if (field === "keyframes") return then.fields.animations !== now.fields.animations;
	if (field === "element") return then.fields.whole !== now.fields.whole;
	if (field === "track") return then.trackId !== now.trackId;
	if (field === "content") return then.content !== now.content;
	if (field.startsWith("params.")) return then.fields.params[field.slice(7)] !== now.fields.params[field.slice(7)];
	return then.fields[field as "start" | "duration" | "trimStart"] !== now.fields[field as "start" | "duration" | "trimStart"];
}

function currentValues(fields: string[], element: TimelineElement, record: ElementRecord): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		if (field === "keyframes") out.keyframes = (element as { animations?: unknown }).animations ?? null;
		else if (field === "element") out.element = element;
		else if (field === "track") out.trackId = record.trackId;
		else if (field === "content") out.content = "changed";
		else if (field.startsWith("params.")) out[field] = element.params?.[field.slice(7)];
		else out[field] = record.fields[field as "start" | "duration" | "trimStart"];
	}
	return out;
}

/**
 * Throws StaleError when `fields` of the element changed between the snapshot (`base`) and the timeline
 * before the draft (`now`). `"all"` (delete and replace) compares the whole element, its track and, for a
 * compound clip, everything inside it. An element in `now` but not in `base` appeared after the snapshot,
 * which is stale too; one in neither was added by this draft and is not checked.
 */
export function assertNotStale({ base, now, sceneId, element, fields }: { base: Map<string, ElementRecord> | undefined; now: Map<string, ElementRecord> | undefined; sceneId: string; element: TimelineElement; fields: string[] | "all" }) {
	if (!base || !now) return;
	const key = `${sceneId}:${element.id}`;
	const current = now.get(key);
	if (!current) return;
	const then = base.get(key);
	if (!then) throw new StaleError(["the element (added after basedOn)"], { id: element.id });
	const list = fields === "all" ? ["element", "track", ...(then.content !== null || current.content !== null ? ["content"] : [])] : fields;
	const changed = list.filter((field) => differs(field, then, current));
	if (changed.length) throw new StaleError(changed, currentValues(changed, element, current));
}

/**
 * Ripple editing moves later clips. A clip the user moved after the snapshot must not be moved again by an
 * op based on that snapshot: throws StaleError for the first element of `after` whose start differs from
 * `before` (this op's own edit) and whose start the user changed since `base`.
 */
export function assertRippleNotStale({ base, now, sceneId, before, after }: { base: Map<string, ElementRecord> | undefined; now: Map<string, ElementRecord> | undefined; sceneId: string; before: TScene["tracks"]; after: TScene["tracks"] }) {
	if (!base || !now) return;
	const startOf = new Map<string, number>();
	for (const track of orderedTracks(before)) for (const element of track.elements) startOf.set(element.id, element.startTime);
	for (const track of orderedTracks(after)) {
		for (const element of track.elements) {
			const was = startOf.get(element.id);
			if (was === undefined || was === element.startTime) continue;
			const key = `${sceneId}:${element.id}`;
			const then = base.get(key);
			const current = now.get(key);
			if (!current) continue;
			if (!then || then.fields.start !== current.fields.start) {
				throw new StaleError([`start of ${element.name || element.id} (moved by ripple)`], { id: element.id, start: current.fields.start });
			}
		}
	}
}
