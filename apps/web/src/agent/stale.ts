// Editing on top of the user's edits: a draft says which snapshot it was computed from (`basedOn`, the
// snapshot's `syncedAt`). A set/replace/delete whose target changed in a field the op touches after that
// snapshot is refused as stale, with the current values, so the agent re-reads and applies on top of them.
// Nothing is locked: ops on unchanged fields (and on elements the user did not touch) apply as usual.
import type { TimelineElement, TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { orderedTracks } from "./scene-graph";

/** The comparable state of one element: timing in seconds, each param and the keyframes as JSON. */
export type ElementFields = { start: number; duration: number; trimStart: number; params: Record<string, string>; animations: string };

const sec = (t: number) => Math.round((t / TICKS_PER_SECOND) * 1e6) / 1e6;

export function fieldsOf(element: TimelineElement): ElementFields {
	const params: Record<string, string> = {};
	for (const [key, value] of Object.entries(element.params ?? {})) params[key] = JSON.stringify(value);
	return {
		start: sec(element.startTime),
		duration: sec(element.duration),
		trimStart: sec(element.trimStart),
		params,
		animations: JSON.stringify((element as { animations?: unknown }).animations ?? null),
	};
}

/** Every element of every scene, keyed `sceneId:elementId`. */
export function fieldsMapOf(scenes: TScene[]): Map<string, ElementFields> {
	const map = new Map<string, ElementFields>();
	for (const scene of scenes) for (const track of orderedTracks(scene.tracks)) for (const element of track.elements) map.set(`${scene.id}:${element.id}`, fieldsOf(element));
	return map;
}

/** A bounded history of snapshots the editor sent, so a draft's `basedOn` can be compared with now. */
export class SnapshotHistory {
	private entries: { at: string; fields: Map<string, ElementFields> }[] = [];
	constructor(private readonly size = 64) {}
	record(at: string, scenes: TScene[]) {
		this.entries.push({ at, fields: fieldsMapOf(scenes) });
		if (this.entries.length > this.size) this.entries.shift();
	}
	get(at: string): Map<string, ElementFields> | undefined {
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

function differs(field: string, then: ElementFields, now: ElementFields): boolean {
	if (field === "keyframes") return then.animations !== now.animations;
	if (field.startsWith("params.")) return then.params[field.slice(7)] !== now.params[field.slice(7)];
	return then[field as "start" | "duration" | "trimStart"] !== now[field as "start" | "duration" | "trimStart"];
}

function currentValues(fields: string[], element: TimelineElement): Record<string, unknown> {
	const now = fieldsOf(element);
	const out: Record<string, unknown> = {};
	for (const field of fields) {
		if (field === "keyframes") out.keyframes = (element as { animations?: unknown }).animations ?? null;
		else if (field.startsWith("params.")) out[field] = element.params?.[field.slice(7)];
		else out[field] = now[field as "start" | "duration" | "trimStart"];
	}
	return out;
}

/**
 * Throws StaleError when `fields` of the element changed since `base` (all fields when `fields` is "all",
 * as for delete and replace). An element missing from `base` appeared after it, which also counts as stale.
 */
export function assertNotStale({ base, sceneId, element, fields }: { base: Map<string, ElementFields> | undefined; sceneId: string; element: TimelineElement; fields: string[] | "all" }) {
	if (!base) return;
	const then = base.get(`${sceneId}:${element.id}`);
	const now = fieldsOf(element);
	if (!then) throw new StaleError(["the element (added after basedOn)"], { id: element.id });
	const list = fields === "all"
		? ["start", "duration", "trimStart", ...new Set([...Object.keys(then.params), ...Object.keys(now.params)].map((k) => `params.${k}`)), "keyframes"]
		: fields;
	const changed = list.filter((field) => differs(field, then, now));
	if (changed.length) throw new StaleError(changed, currentValues(changed, element));
}
