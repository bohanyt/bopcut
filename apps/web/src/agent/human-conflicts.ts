import { getSourceSpanAtClipTime } from "@/retime";
import { roundMediaTime, TICKS_PER_SECOND } from "@/wasm";
import type { TimelineElement, TimelineTrack } from "@/timeline";
import {
	changedHumanFields,
	normalizeHumanFields,
	withHumanFields,
} from "@/timeline/human-fields";
import { secs } from "./elements";

const timingKeys = { start: "startTime", duration: "duration", trimStart: "trimStart" } as const;
type Timing = Partial<Record<keyof typeof timingKeys, number>>;

export function keepTiming<T extends Timing>(
	request: T,
	before: TimelineElement,
	protectedFields: ReadonlySet<string>,
	kept: Set<string>,
): T {
	const timing: Timing = { ...request };
	for (const field of ["start", "duration", "trimStart"] as const) {
		if (!protectedFields.has(field)) continue;
		const wanted = request[field];
		if (wanted === undefined) continue;
		const current = before[timingKeys[field]];
		if (secs(wanted) !== current) kept.add(field);
		timing[field] = current / TICKS_PER_SECOND;
	}
	return timing as T;
}

export function validateKeptFit({
	before, element, track, originalTrack, source,
}: {
	before: TimelineElement;
	element: TimelineElement;
	track: { id: string; elements: readonly TimelineElement[] };
	originalTrack: TimelineTrack;
	source?: number;
}): TimelineElement {
	const { startTime, duration, trimStart } = element;
	if (![startTime, duration, trimStart].every(Number.isFinite) || startTime < 0 || duration <= 0 || trimStart < 0) {
		throw new Error("the merged clip needs a nonnegative start and trim and a positive duration");
	}
	if (source !== undefined) {
		const span = getSourceSpanAtClipTime({ clipTime: duration, retime: "retime" in element ? element.retime : undefined });
		const remaining = source - trimStart - roundMediaTime({ time: span });
		if (remaining < 0) throw new Error("the merged clip runs past the end of its source");
		element = { ...element, trimEnd: roundMediaTime({ time: remaining }) };
	}
	if (startTime !== before.startTime || duration !== before.duration || track.id !== originalTrack.id) {
		const end = startTime + duration;
		const clash = track.elements.find((other) => other.id !== before.id && other.id !== element.id &&
			other.startTime < end && other.startTime + other.duration > startTime);
		if (clash) throw new Error(`the merged clip would overlap ${clash.name || clash.id} on its track`);
	}
	return element;
}

function restoreKey(
	before: Record<string, unknown> | undefined,
	after: Record<string, unknown> | undefined,
	key: string,
) {
	const result = { ...after };
	if (before && Object.hasOwn(before, key))
		Object.defineProperty(result, key, {
			value: before[key],
			enumerable: true,
			configurable: true,
			writable: true,
		});
	else delete result[key];
	return result;
}

export function mergeHumanFields({
	before,
	candidate,
	keep,
	take,
	stale = [],
}: {
	before: TimelineElement;
	candidate: TimelineElement;
	keep: boolean;
	take: ReadonlySet<string>;
	stale?: readonly string[];
}): { element: TimelineElement; kept: string[] } {
	const owned = before.humanFields ?? [];
	if (!before.agentId || (!owned.length && !stale.length))
		return { element: candidate, kept: [] };
	const changes = new Set(changedHumanFields(before, candidate));
	const captionChanged = changes.has("caption");
	const canonical = (path: string) =>
		captionChanged && path === "params.content" ? "caption" : path;
	const kept = keep
		? [...new Set([...owned, ...stale].map(canonical))]
				.filter(
					(field) =>
						!take.has(field) &&
						changes.has(field),
				)
				.sort()
		: [];
	if (kept.length && before.type !== candidate.type)
		return { element: before, kept };

	let element = candidate;
	for (const field of kept) {
		if (field === "start")
			element = { ...element, startTime: before.startTime };
		else if (field === "duration")
			element = { ...element, duration: before.duration };
		else if (field === "trimStart")
			element = { ...element, trimStart: before.trimStart };
		else if (field === "retime" && "retime" in before)
			element = { ...element, retime: before.retime } as TimelineElement;
		else if (field === "retime" && "retime" in element)
			element = { ...element, retime: undefined } as TimelineElement;
		else if (
			field === "caption" &&
			before.type === "text" &&
			element.type === "text"
		) {
			element = {
				...element,
				caption: before.caption,
				params: restoreKey(
					before.params,
					element.params,
					"content",
				) as typeof element.params,
			};
		} else if (field.startsWith("params.")) {
			element = {
				...element,
				params: restoreKey(
					before.params,
					element.params,
					field.slice(7),
				) as typeof element.params,
			};
		} else if (field.startsWith("keyframes.")) {
			const animations = restoreKey(
				before.animations,
				element.animations,
				field.slice(10),
			);
			element = {
				...element,
				animations: Object.keys(animations).length
					? (animations as typeof element.animations)
					: undefined,
			};
		}
	}
	const actual = new Set(changedHumanFields(before, element));
	// An explicit track override is handled by placement, which knows the resulting track.
	const fields = owned.filter((field) => !actual.has(canonical(field)) &&
		(!keep || (!take.has(field) && !take.has(canonical(field)))));
	return { element: withHumanFields(element, fields), kept };
}

export function takeHumanFields(value: unknown): ReadonlySet<string> {
	if (value === undefined) return new Set();
	const fields = normalizeHumanFields(value);
	if (!Array.isArray(value) || value.some((field) => !fields.includes(field))) {
		throw new Error("take must contain supported field paths");
	}
	return new Set(fields);
}
