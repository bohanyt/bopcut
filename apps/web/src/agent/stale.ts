// Editing on top of the user's edits: a draft says which snapshot it was computed from (`basedOn`, the
// snapshot's `syncedAt`). A set/replace/delete whose target changed in a field the op touches after that
// snapshot is refused as stale, with the current values, so the agent re-reads and applies on top of them.
// Nothing is locked: ops on unchanged fields (and on elements the user did not touch) apply as usual.
//
// Every check compares the snapshot (`base`) with the timeline as it was before the draft (`now`), never
// with the draft's own intermediate state, so two ops of one draft never trip over each other.
import type { TimelineElement, TScene } from "@/timeline";
import { isHumanFieldPath } from "@/timeline/human-fields";
import { TICKS_PER_SECOND } from "@/wasm";
import { orderedTracks } from "./scene-graph";

/** The comparable state of one element: timing in seconds, each param and the keyframes as JSON. */
export type ElementFields = { start: number; duration: number; trimStart: number; params: Record<string, string>; animations: string; caption: string; retime?: string; unmanaged?: string; whole: string };

/**
 * One element in a snapshot: its fields, the track it is on and that track's own settings (name, mute,
 * hidden), and (compound clips) a digest of their content. Notes are kept the same way (`note:<id>`).
 */
export type ElementRecord = { fields: ElementFields; trackId: string; trackState: string; content: string | null };

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
// A changed element usually keeps its params and keyframes objects (a move or trim only replaces the
// element), so those are serialized once per object and shared by every record that has them.
const fieldsCache = new WeakMap<object, ElementFields>();
const paramsCache = new WeakMap<object, { params: Record<string, string>; digest: string }>();
const jsonCache = new WeakMap<object, { json: string; digest: string }>();
const NO_PARAMS = { params: {} as Record<string, string>, digest: digest("{}") };

function paramsOf(value: unknown): { params: Record<string, string>; digest: string } {
	if (!value || typeof value !== "object") return NO_PARAMS;
	const cached = paramsCache.get(value);
	if (cached) return cached;
	const params: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) params[key] = stableJson(entry);
	const out = { params, digest: digest(Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("\u0000")) };
	paramsCache.set(value, out);
	return out;
}

function jsonOf(value: unknown): { json: string; digest: string } {
	if (!value || typeof value !== "object") {
		const json = stableJson(value ?? null);
		return { json, digest: digest(json) };
	}
	const cached = jsonCache.get(value);
	if (cached) return cached;
	const json = stableJson(value);
	const out = { json, digest: digest(json) };
	jsonCache.set(value, out);
	return out;
}

export function fieldsOf(element: TimelineElement): ElementFields {
	const cached = fieldsCache.get(element);
	if (cached) return cached;
	const { humanFields: _ownership, params: rawParams, animations: rawAnimations, caption: rawCaption, ...rest } = element as TimelineElement & { animations?: unknown; caption?: unknown };
	const params = paramsOf(rawParams);
	const animations = jsonOf(rawAnimations ?? null);
	// A caption's words, timings and highlights (kept beside the text).
	const caption = jsonOf(rawCaption ?? null);
	const fields: ElementFields = {
		start: sec(element.startTime),
		duration: sec(element.duration),
		trimStart: sec(element.trimStart),
		params: params.params,
		animations: animations.json,
		caption: caption.digest,
		retime: stableJson("retime" in element ? element.retime : undefined),
		unmanaged: (() => {
			const { startTime, duration, trimStart, trimEnd, retime, ...unmanaged } = rest as typeof rest & { retime?: unknown };
			const untouchedChannels = Object.fromEntries(
				Object.entries(rawAnimations && typeof rawAnimations === "object" ? rawAnimations : {})
					.filter(([path]) => !isHumanFieldPath(`keyframes.${path}`)),
			);
			const untouchedParams = element.type === "effect" ? params.params : Object.fromEntries(
				Object.entries(params.params).filter(([key]) => !isHumanFieldPath(`params.${key}`)),
			);
			return digest(stableJson({ unmanaged, untouchedChannels, untouchedParams }));
		})(),
		whole: digest(`${stableJson(rest)}|${params.digest}|${animations.digest}|${caption.digest}`),
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
	// Notes inside a compound clip are part of what a delete would make unreachable.
	const parts: string[] = [`bookmarks:${stableJson(scene.bookmarks ?? [])}`];
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

/**
 * Every element of every scene, keyed `sceneId:elementId`, and also `#elementId` when that id is in one
 * scene only: an element an earlier op of the draft moved into another scene (group) is still found.
 */
export function fieldsMapOf(scenes: TScene[]): Map<string, ElementRecord> {
	const byId = new Map(scenes.map((scene) => [scene.id, scene] as const));
	const map = new Map<string, ElementRecord>();
	const seen = new Map<string, number>();
	for (const scene of scenes) {
		for (const bookmark of scene.bookmarks ?? []) {
			const id = bookmark.id ?? `legacy-${bookmark.time}`;
			map.set(`note:${scene.id}:${id}`, { fields: { ...NO_FIELDS, whole: digest(stableJson(bookmark)) }, trackId: "", trackState: "", content: null });
		}
		for (const track of orderedTracks(scene.tracks)) {
			const trackState = digest(stableJson({ ...track, elements: undefined }));
			for (const element of track.elements) {
				const nested = (element as { sceneId?: unknown }).sceneId;
				const content = element.type === "compound" && typeof nested === "string" ? contentOf(nested, byId) : null;
				const record = { fields: fieldsOf(element), trackId: track.id, trackState, content };
				map.set(`${scene.id}:${element.id}`, record);
				seen.set(element.id, (seen.get(element.id) ?? 0) + 1);
				map.set(`#${element.id}`, record);
			}
		}
	}
	for (const [id, count] of seen) if (count > 1) map.delete(`#${id}`);
	return map;
}

const NO_FIELDS: ElementFields = { start: 0, duration: 0, trimStart: 0, params: {}, animations: "", caption: "", whole: "" };

/** The record of an element in its scene, else by its id alone (it was moved to another scene). */
function recordOf(map: ReadonlyMap<string, ElementRecord>, sceneId: string, elementId: string): ElementRecord | undefined {
	return map.get(`${sceneId}:${elementId}`) ?? map.get(`#${elementId}`);
}

/**
 * A bounded history of snapshots the editor sent, so a draft's `basedOn` can be compared with now. With
 * `meta`, the timeline itself is kept too (by reference), for changes and frames of that state.
 */
type SnapshotState = { projectId: string; rootSceneId: string; scenes: TScene[] } & Record<string, unknown>;
export class SnapshotHistory {
	private entries: { at: string; sceneKey: symbol; fields: ReadonlyMap<string, ElementRecord>; state: SnapshotState | null }[] = [];
	// Keep identities weak. Only live snapshot entries should retain their element indexes.
	private readonly sceneKeys = new WeakMap<TScene[], symbol>();
	/** `keep`: what of the scenes a kept state holds (for example without decoded audio). */
	constructor(private readonly size = 64, private readonly keep: (scenes: TScene[]) => TScene[] = (scenes) => scenes) {}
	record(at: string, scenes: TScene[], meta?: { projectId: string; rootSceneId: string } & Record<string, unknown>) {
		const sceneKey = this.sceneKeys.get(scenes) ?? Symbol();
		this.sceneKeys.set(scenes, sceneKey);
		const fields = this.entries.find((entry) => entry.sceneKey === sceneKey)?.fields ?? fieldsMapOf(scenes);
		this.entries = this.entries.filter((entry) => entry.at !== at);
		this.entries.push({ at, sceneKey, fields, state: meta ? { ...meta, scenes: this.keep(scenes) } : null });
		if (this.entries.length > this.size) this.entries.shift();
	}
	get(at: string): ReadonlyMap<string, ElementRecord> | undefined {
		return this.entries.find((entry) => entry.at === at)?.fields;
	}
	/** The timeline as that snapshot showed it, when it was recorded with its project. */
	state(at: string): SnapshotState | null {
		return this.entries.find((entry) => entry.at === at)?.state ?? null;
	}
}

export class StaleError extends Error {
	constructor(readonly fields: string[], readonly current: Record<string, unknown>) {
		super(`stale: the user changed ${fields.join(", ")} after basedOn; re-read the snapshot and apply on top of the current values`);
	}
}

/**
 * Fields a set op touches: timing it sets, each param key, and keyframes. A caption update rewrites the
 * text, its words and timings and its style, so it counts as touching the whole element.
 */
export function touchedFields(op: { start?: unknown; duration?: unknown; trimStart?: unknown; params?: Record<string, unknown>; keyframes?: unknown; keyframesMode?: unknown; caption?: unknown; cut?: unknown; startAtWord?: unknown; endAfterWord?: unknown }): string[] {
	const fields: string[] = [];
	// Snapping cuts to words, or cutting at named words, can move the start and change the length.
	if (op.cut !== undefined || op.startAtWord !== undefined || op.endAfterWord !== undefined) fields.push("trimStart", "duration");
	if (op.caption !== undefined) fields.push("element");
	if (op.start !== undefined) fields.push("start");
	if (op.duration !== undefined) fields.push("duration");
	if (op.trimStart !== undefined) fields.push("trimStart");
	for (const key of Object.keys(op.params ?? {})) fields.push(`params.${key}`);
	if (op.keyframes !== undefined || op.keyframesMode !== undefined) fields.push("keyframes");
	return fields;
}

function differs(field: string, then: ElementRecord, now: ElementRecord): boolean {
	if (field === "keyframes") return then.fields.animations !== now.fields.animations;
	if (field === "caption") return then.fields.caption !== now.fields.caption;
	if (field === "retime" || field === "unmanaged") return then.fields[field] !== now.fields[field];
	if (field === "element") return then.fields.whole !== now.fields.whole;
	if (field === "track") return then.trackId !== now.trackId || then.trackState !== now.trackState;
	if (field === "trackSettings") return then.trackId === now.trackId && then.trackState !== now.trackState;
	if (field === "content") return then.content !== now.content;
	if (field.startsWith("params.")) return then.fields.params[field.slice(7)] !== now.fields.params[field.slice(7)];
	return then.fields[field as "start" | "duration" | "trimStart"] !== now.fields[field as "start" | "duration" | "trimStart"];
}

function currentValues(fields: string[], element: TimelineElement, record: ElementRecord): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		if (field === "keyframes") out.keyframes = (element as { animations?: unknown }).animations ?? null;
		else if (field === "caption") out.caption = (element as { caption?: unknown }).caption ?? null;
		else if (field === "element" || field === "unmanaged") out.element = element;
		else if (field === "track" || field === "trackSettings") out.trackId = record.trackId; // or its settings (mute, hidden, name) changed
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
export function assertNotStale({ base, now, sceneId, element, fields, scenes }: {
	base: ReadonlyMap<string, ElementRecord> | undefined; now: ReadonlyMap<string, ElementRecord> | undefined; sceneId: string; element: TimelineElement; fields: string[] | "all";
	/** The draft's scenes so far: what a compound this draft made (a `group` wrapper) holds is checked too. */
	scenes?: TScene[];
}) {
	if (!base || !now) return;
	const current = recordOf(now, sceneId, element.id);
	if (!current) {
		// Made by this draft. A compound it made can hold the user's clips (group): those are checked whole,
		// unless only the track is checked (grouping it again keeps what it holds).
		if (fields !== "all" && fields.every((field) => field === "track")) return;
		const nested = (element as { sceneId?: unknown }).sceneId;
		const content = element.type === "compound" && typeof nested === "string" ? scenes?.find((scene) => scene.id === nested) : undefined;
		if (content) {
			for (const track of orderedTracks(content.tracks)) {
				for (const child of track.elements) assertNotStale({ base, now, sceneId: content.id, element: child, fields: "all", scenes });
			}
		}
		return;
	}
	const then = recordOf(base, sceneId, element.id);
	if (!then) throw new StaleError(["the element (added after basedOn)"], { id: element.id });
	// New text on a caption also rewrites its words and highlights: those count as touched too.
	const hasCaption = (element as { caption?: unknown }).caption !== undefined;
	const list = fields === "all"
		? ["element", "track", ...(then.content !== null || current.content !== null ? ["content"] : [])]
		: hasCaption && fields.includes("params.content") ? [...fields, "caption"] : fields;
	const changed = list.filter((field) => differs(field, then, current));
	if (changed.length) throw new StaleError(changed, currentValues(changed, element, current));
}

/** Supported and unmanaged field changes since the snapshot, before any op in this draft. */
export function humanFieldsSince(
	base: ReadonlyMap<string, ElementRecord> | undefined,
	now: ReadonlyMap<string, ElementRecord> | undefined,
	sceneId: string,
	element: TimelineElement,
): string[] {
	if (!base || !now) return [];
	const current = recordOf(now, sceneId, element.id);
	if (!current) return [];
	const then = recordOf(base, sceneId, element.id);
	if (!then) throw new StaleError(["the element (added after basedOn)"], { id: element.id });
	const fields = ["start", "duration", "trimStart", "caption", "retime"].filter((field) => differs(field, then, current));
	if (then.trackId !== current.trackId) fields.push("track");
	for (const key of new Set([...Object.keys(then.fields.params), ...Object.keys(current.fields.params)])) {
		if (!differs(`params.${key}`, then, current)) continue;
		const field = key === "content" && element.type === "text" && element.caption ? "caption" : `params.${key}`;
		if (!fields.includes(field)) fields.push(field);
	}
	const previousKeys = JSON.parse(then.fields.animations) ?? {};
	const currentKeys = JSON.parse(current.fields.animations) ?? {};
	for (const key of new Set([...Object.keys(previousKeys), ...Object.keys(currentKeys)])) {
		if (stableJson(previousKeys[key]) !== stableJson(currentKeys[key])) fields.push(`keyframes.${key}`);
	}
	return fields;
}

/** Throws StaleError when a note changed (resolved, reopened, edited) between the snapshot and now. */
export function assertNoteNotStale({ base, now, sceneId, noteId }: { base: ReadonlyMap<string, ElementRecord> | undefined; now: ReadonlyMap<string, ElementRecord> | undefined; sceneId: string; noteId: string }) {
	if (!base || !now) return;
	const current = now.get(`note:${sceneId}:${noteId}`);
	if (!current) return;
	const then = base.get(`note:${sceneId}:${noteId}`);
	if (!then) throw new StaleError(["the note (added after basedOn)"], { id: noteId });
	if (then.fields.whole !== current.fields.whole) throw new StaleError(["note"], { id: noteId });
}

/**
 * Ripple editing moves later clips. A clip the user moved after the snapshot must not be moved again by an
 * op based on that snapshot: throws StaleError for the first element of `after` whose start differs from
 * `before` (this op's own edit) and whose start the user changed since `base`.
 */
export function assertRippleNotStale({ base, now, sceneId, before, after, startReleased }: {
	base: ReadonlyMap<string, ElementRecord> | undefined; now: ReadonlyMap<string, ElementRecord> | undefined;
	sceneId: string; before: TScene["tracks"]; after: TScene["tracks"]; startReleased?: (id: string) => boolean;
}) {
	if (!base || !now) return;
	const startOf = new Map<string, number>();
	for (const track of orderedTracks(before)) for (const element of track.elements) startOf.set(element.id, element.startTime);
	for (const track of orderedTracks(after)) {
		for (const element of track.elements) {
			const was = startOf.get(element.id);
			if (was === undefined || was === element.startTime || startReleased?.(element.id)) continue;
			const then = recordOf(base, sceneId, element.id);
			const current = recordOf(now, sceneId, element.id);
			if (!current) continue;
			if (!then || then.fields.start !== current.fields.start) {
				throw new StaleError([`start of ${element.name || element.id} (moved by ripple)`], { id: element.id, start: current.fields.start });
			}
		}
	}
}
