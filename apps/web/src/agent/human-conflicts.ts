import { getSourceSpanAtClipTime } from "@/retime";
import { roundMediaTime } from "@/wasm";
import type { TimelineElement } from "@/timeline";
import {
	changedHumanFields,
	normalizeHumanFields,
	withHumanFields,
} from "@/timeline/human-fields";

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
	replacing = false,
}: {
	before: TimelineElement;
	candidate: TimelineElement;
	keep: boolean;
	take: ReadonlySet<string>;
	stale?: readonly string[];
	replacing?: boolean;
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
						(changes.has(field) || (replacing && field === "track")),
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
	if (
		element.sourceDuration !== undefined &&
		kept.some(
			(field) =>
				field === "duration" || field === "trimStart" || field === "retime",
		)
	) {
		const sourceSpan = getSourceSpanAtClipTime({
			clipTime: element.duration,
			retime: "retime" in element ? element.retime : undefined,
		});
		element = {
			...element,
			trimEnd: roundMediaTime({
				time: Math.max(
					0,
					element.sourceDuration - element.trimStart - sourceSpan,
				),
			}),
		};
	}
	const actual = new Set(changedHumanFields(before, element));
	// An explicit track override is handled by placement, which knows the resulting track.
	const fields = owned.filter((field) => !actual.has(canonical(field)));
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
