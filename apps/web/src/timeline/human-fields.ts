import { getElementParam } from "@/params/registry";
import { resolveAnimationTarget } from "./animation-targets";
import type { SceneTracks, TimelineElement, TimelineTrack } from "./types";

const simpleFields = new Set([
	"start",
	"duration",
	"trimStart",
	"track",
	"caption",
	"retime",
]);
export const isHumanFieldPath = (path: unknown): path is string =>
	typeof path === "string" &&
	(simpleFields.has(path) ||
		(/^(params|keyframes)\.[a-zA-Z0-9_][\w.-]*$/.test(path) &&
			!/^(params|keyframes)\.(effects|masks?)(\.|$)/.test(path)));

export function normalizeHumanFields(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value.filter(isHumanFieldPath))].sort()
		: [];
}

export function withHumanFields<T extends TimelineElement>(
	element: T,
	fields: readonly string[],
): T {
	const next = element.agentId ? normalizeHumanFields(fields) : [];
	if (element.humanFields === undefined && !next.length) return element;
	if (
		next.length &&
		next.length === element.humanFields?.length &&
		next.every((field, i) => field === element.humanFields?.[i])
	)
		return element;
	const { humanFields: _, ...rest } = element;
	return { ...rest, ...(next.length ? { humanFields: next } : {}) } as T;
}

export const equalHumanValue = (a: unknown, b: unknown): boolean => {
	if (Object.is(a, b)) return true;
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const left = a as Record<string, unknown>,
		right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	return (
		Array.isArray(a) === Array.isArray(b) &&
		keys.length === Object.keys(right).length &&
		keys.every(
			(key) =>
				Object.hasOwn(right, key) && equalHumanValue(left[key], right[key]),
		)
	);
};

const caption = (element: TimelineElement) =>
	element.type === "text" ? element.caption : undefined;
const retime = (element: TimelineElement) =>
	"retime" in element ? element.retime : undefined;

function changedKeys(
	prefix: string,
	before: Record<string, unknown> | undefined,
	after: Record<string, unknown> | undefined,
	into: string[],
) {
	if (before === after) return;
	for (const key of new Set([
		...Object.keys(before ?? {}),
		...Object.keys(after ?? {}),
	])) {
		if (!equalHumanValue(before?.[key], after?.[key])) into.push(prefix + key);
	}
}

export function changedHumanFields(
	before: TimelineElement,
	after: TimelineElement,
): string[] {
	const fields: string[] = [];
	if (before.startTime !== after.startTime) fields.push("start");
	if (before.duration !== after.duration) fields.push("duration");
	if (before.trimStart !== after.trimStart) fields.push("trimStart");
	if (!equalHumanValue(retime(before), retime(after))) fields.push("retime");
	const hasCaption =
		caption(before) !== undefined || caption(after) !== undefined;
	if (
		hasCaption &&
		(!equalHumanValue(caption(before), caption(after)) ||
			before.params.content !== after.params.content)
	) {
		fields.push("caption");
	}
	if (before.type !== "effect" && after.type !== "effect") {
		changedKeys("params.", before.params, after.params, fields);
	}
	changedKeys("keyframes.", before.animations, after.animations, fields);
	return fields.filter((field) => !(hasCaption && field === "params.content"));
}

function mapTracks(
	tracks: SceneTracks,
	update: <T extends TimelineTrack>(track: T) => T,
): SceneTracks {
	const main = update(tracks.main);
	const overlay = tracks.overlay.map(update);
	const audio = tracks.audio.map(update);
	return main === tracks.main &&
		overlay.every((t, i) => t === tracks.overlay[i]) &&
		audio.every((t, i) => t === tracks.audio[i])
		? tracks
		: { main, overlay, audio };
}

function mapElements<T extends TimelineTrack>(
	track: T,
	update: (element: TimelineElement) => TimelineElement,
): T {
	let elements: TimelineElement[] | undefined;
	for (const [i, element] of track.elements.entries()) {
		const next = update(element);
		if (next !== element) {
			elements ??= [...track.elements];
			elements[i] = next;
		}
	}
	return elements ? ({ ...track, elements } as T) : track;
}

export function normalizeTrackHumanFields(tracks: SceneTracks): SceneTracks {
	return mapTracks(tracks, (track) =>
		mapElements(track, (element) => {
			const fields = element.humanFields;
			if (fields === undefined) return element;
			const known = normalizeHumanFields(fields).filter((field) => {
				if (field.startsWith("params.")) {
					const key = field.slice(7);
					return (
						element.type !== "effect" &&
						(Object.hasOwn(element.params ?? {}, key) ||
							!!getElementParam({ element, key }))
					);
				}
				if (field.startsWith("keyframes.")) {
					const path = field.slice(10);
					return (
						!!element.animations?.[path] ||
						!!resolveAnimationTarget({ element, path })
					);
				}
				return field === "caption"
					? element.type === "text"
					: field === "retime"
						? element.type === "video" || element.type === "audio"
						: true;
			});
			return withHumanFields(element, known);
		}),
	);
}

export function recordHumanElementEdit(
	before: TimelineElement,
	after: TimelineElement,
	movedTrack = false,
): TimelineElement {
	if (
		!after.agentId ||
		before.agentId !== after.agentId ||
		(before === after && !movedTrack)
	)
		return after;
	const fields = changedHumanFields(before, after);
	if (movedTrack) fields.push("track");
	return fields.length
		? withHumanFields(after, [...(after.humanFields ?? []), ...fields])
		: after;
}

export function recordHumanTrackEdit(
	before: SceneTracks,
	after: SceneTracks,
	onlyId?: string,
): SceneTracks {
	if (before === after) return after;
	const oldTracks = [before.main, ...before.overlay, ...before.audio];
	const nextTracks = [after.main, ...after.overlay, ...after.audio];
	const oldById = new Map(oldTracks.map((track) => [track.id, track.elements]));
	const nextById = new Map(
		nextTracks.map((track) => [track.id, track.elements]),
	);
	const previous = new Map<
		string,
		{ element: TimelineElement; trackId: string }
	>();
	for (const track of oldTracks) {
		if (nextById.get(track.id) === track.elements) continue;
		for (const element of track.elements) {
			if (element.agentId && (!onlyId || element.id === onlyId))
				previous.set(element.id, { element, trackId: track.id });
		}
	}
	if (!previous.size) return after;
	return mapTracks(after, (track) =>
		oldById.get(track.id) === track.elements
			? track
			: mapElements(track, (element) => {
					const old = previous.get(element.id);
					return old
						? recordHumanElementEdit(
								old.element,
								element,
								old.trackId !== track.id,
							)
						: element;
				}),
	);
}
