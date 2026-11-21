// Splitting one timeline element in two at a timeline time (pure).
import { withoutPresetSide } from "@/animation/presets";
import type { TimelineElement } from "@/timeline";
import { isRetimableElement } from "@/timeline";
import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime } from "@/retime";
import { addMediaTime, type MediaTime, roundMediaTime, subMediaTime } from "@/wasm";

/**
 * The two parts of an element split at `splitTime` (timeline time), or null when that time is not
 * strictly inside it. The right part gets `rightId`. Trims follow the source (also for retimed clips:
 * the source split point is snapped once and the right part is derived from it), keyframes are split
 * at the boundary, and the left part keeps only the fade-in, the right part only the fade-out.
 */
export function splitElementAt({
	element,
	splitTime,
	rightId,
	boundaryIdPrefix,
}: {
	element: TimelineElement;
	splitTime: MediaTime;
	rightId: string;
	boundaryIdPrefix?: string;
}): { left: TimelineElement; right: TimelineElement } | null {
	const start = element.startTime;
	const end = element.startTime + element.duration;
	if (splitTime <= start || splitTime >= end) return null;
	const relativeTime = subMediaTime({ a: splitTime, b: element.startTime });
	const leftVisibleDuration = relativeTime;
	const rightVisibleDuration = subMediaTime({ a: element.duration, b: relativeTime });
	const retimeRef = isRetimableElement(element) ? element.retime : undefined;
	// Snap the source-side split point exactly once and derive the right half from it, so
	// `leftSourceSpan + rightSourceSpan == totalSourceSpan` holds (see compute-resize.ts).
	const leftSourceSpan = roundMediaTime({ time: getSourceSpanAtClipTime({ clipTime: leftVisibleDuration, retime: retimeRef }) });
	const totalSourceSpan = roundMediaTime({ time: getSourceSpanAtClipTime({ clipTime: element.duration, retime: retimeRef }) });
	const rightSourceSpan = subMediaTime({ a: totalSourceSpan, b: leftSourceSpan });
	const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
		animations: element.animations,
		splitTime: relativeTime,
		boundaryIdPrefix,
	});
	// Like audio fades, the left part keeps what happens at the start, the right part what happens at the end.
	const withoutFade = (key: "fadeIn" | "fadeOut") => {
		const params = { ...element.params };
		let changed = false;
		if (typeof params[key] === "number" && params[key] > 0) {
			params[key] = 0;
			changed = true;
		}
		const kept = withoutPresetSide(params, key === "fadeIn" ? "in" : "out");
		return changed || kept !== params ? { params: kept } : {};
	};
	return {
		left: {
			...element,
			...withoutFade("fadeOut"),
			duration: leftVisibleDuration,
			trimEnd: addMediaTime({ a: element.trimEnd, b: rightSourceSpan }),
			name: `${element.name} (left)`,
			animations: leftAnimations,
			...(retimeRef !== undefined ? { retime: retimeRef } : {}),
		} as TimelineElement,
		right: {
			...element,
			...withoutFade("fadeIn"),
			id: rightId,
			startTime: splitTime,
			duration: rightVisibleDuration,
			trimStart: addMediaTime({ a: element.trimStart, b: leftSourceSpan }),
			name: `${element.name} (right)`,
			animations: rightAnimations,
			...(retimeRef !== undefined ? { retime: retimeRef } : {}),
		} as TimelineElement,
	};
}
