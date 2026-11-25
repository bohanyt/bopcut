import { clampAnimationsToDuration, splitAnimationsAtTime } from "@/animation";
import {
	clampRetimeRate,
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/retime";
import type { ElementRef, RetimeConfig, SceneTracks, TimelineElement, TimelineTrack } from "@/timeline";
import { isRetimableElement } from "@/timeline";
import {
	findTrackInSceneTracks,
	updateElementInSceneTracks,
	updateTrackInSceneTracks,
} from "@/timeline/track-element-update";
import { rippleShiftElements } from "@/ripple";
import { ZERO_MEDIA_TIME, roundMediaTime, subMediaTime } from "@/wasm";
import { reconcileCaptionEdit } from "@/text/caption";

type ElementUpdateField = keyof TimelineElement | string;

export interface ElementUpdate extends ElementRef {
	patch: Partial<TimelineElement>;
}

export function applyElementUpdates({
	tracks,
	updates,
	boundaryIdPrefix,
}: {
	tracks: SceneTracks;
	updates: readonly ElementUpdate[];
	boundaryIdPrefix: string;
}): SceneTracks {
	let updatedTracks = tracks;
	for (const [index, { trackId, elementId, patch }] of updates.entries()) {
		const track = findTrackInSceneTracks({ tracks: updatedTracks, trackId });
		if (!track?.elements.some((element) => element.id === elementId)) continue;
		const context = {
			tracks: updatedTracks,
			trackId,
			boundaryIdPrefix: `${boundaryIdPrefix}:${index}`,
		};
		updatedTracks = updateElementInSceneTracks({
			tracks: updatedTracks,
			trackId,
			elementId,
			update: (element) => applyElementUpdate({ element, patch, context }),
		});
	}
	return updatedTracks;
}

export function applyElementRetime({
	tracks,
	trackId,
	elementId,
	retime,
	rippleEnabled,
	boundaryIdPrefix,
}: ElementRef & {
	tracks: SceneTracks;
	retime?: RetimeConfig;
	rippleEnabled: boolean;
	boundaryIdPrefix: string;
}): SceneTracks | null {
	const track = findTrackInSceneTracks({ tracks, trackId });
	const element = track?.elements.find((candidate) => candidate.id === elementId);
	if (!track || !element || !isRetimableElement(element)) return tracks;

	const next = applyElementUpdate({
		element,
		patch: { retime },
		context: { tracks, trackId, boundaryIdPrefix },
	});
	if (!isRetimableElement(next)) return tracks;
	const delta = next.duration - element.duration;
	if (delta === 0 && next.retime?.rate === element.retime?.rate &&
		!!next.retime?.maintainPitch === !!element.retime?.maintainPitch) return tracks;

	const end = element.startTime + element.duration;
	let shiftFrom = end;
	let shiftBy = delta;
	if (delta > 0) {
		let nextStart = Infinity;
		for (const candidate of track.elements) {
			if (candidate.id !== elementId && candidate.startTime >= element.startTime) {
				nextStart = Math.min(nextStart, candidate.startTime);
			}
		}
		if (!rippleEnabled && end + delta > nextStart) return null;
		// Preserve gaps to later clips. If old clips already overlap, make room for the new span.
		shiftFrom = Math.min(end, nextStart);
		shiftBy = Math.max(delta, end + delta - nextStart);
	}

	return updateTrackInSceneTracks({
		tracks,
		trackId,
		update: <TTrack extends TimelineTrack>(current: TTrack): TTrack => {
			const elements = rippleEnabled && shiftBy !== 0
				? rippleShiftElements<TimelineElement>({
						elements: current.elements,
						afterTime: shiftFrom,
						shiftAmount: -shiftBy,
					})
				: current.elements;
			return {
				...current,
				elements: elements.map((candidate) => candidate.id === elementId ? next : candidate),
			} as TTrack;
		},
	});
}

export interface ElementUpdateContext {
	tracks: SceneTracks;
	trackId: string;
	boundaryIdPrefix?: string;
}

interface ElementUpdateRuleResult {
	element: TimelineElement;
	changedFields?: ElementUpdateField[];
}

interface ElementUpdateRuleParams {
	element: TimelineElement;
	originalElement: TimelineElement;
	patch: Partial<TimelineElement>;
	context: ElementUpdateContext;
}

interface ElementUpdateRule {
	triggers: ElementUpdateField[];
	apply: (params: ElementUpdateRuleParams) => ElementUpdateRuleResult;
}

const deriveRules: ElementUpdateRule[] = [
	{
		triggers: ["retime"],
		apply: ({ element, originalElement, patch }) => {
			if (!("retime" in patch) || !isRetimableElement(element)) {
				return { element };
			}

			const nextRetime = patch.retime
				? {
						...patch.retime,
						rate: clampRetimeRate({ rate: patch.retime.rate }),
					}
				: undefined;

			const sourceDuration = getSourceDuration({
				trimStart: originalElement.trimStart,
				trimEnd: originalElement.trimEnd,
				duration: originalElement.duration,
				sourceDuration: isRetimableElement(originalElement)
					? originalElement.sourceDuration
					: undefined,
				retime: isRetimableElement(originalElement)
					? originalElement.retime
					: undefined,
			});
			const visibleSourceSpan = Math.max(
				0,
				sourceDuration - element.trimStart - element.trimEnd,
			);
			const nextDuration = roundMediaTime({
				time: getTimelineDurationForSourceSpan({
					sourceSpan: visibleSourceSpan,
					retime: nextRetime,
				}),
			});

			return {
				element: {
					...element,
					retime: nextRetime,
					duration: nextDuration,
				},
				changedFields: ["retime", "duration"],
			};
		},
	},
];

export function animationsAfterLeftTrim({
	element,
	patch,
	startTime = patch.startTime,
	boundaryIdPrefix,
}: {
	element: TimelineElement;
	patch: Partial<TimelineElement>;
	startTime?: TimelineElement["startTime"];
	boundaryIdPrefix?: string;
}): TimelineElement["animations"] {
	if (!element.animations || startTime === undefined || startTime === element.startTime ||
		patch.trimStart === undefined || patch.startTime === undefined || patch.duration === undefined ||
		patch.startTime + patch.duration !== element.startTime + element.duration) {
		return element.animations;
	}
	const splitTime = subMediaTime({ a: startTime, b: element.startTime });
	return splitAnimationsAtTime({
		animations: element.animations,
		splitTime,
		shouldIncludeSplitBoundary: splitTime > ZERO_MEDIA_TIME,
		boundaryIdPrefix,
	}).rightAnimations;
}

const enforceRules: ElementUpdateRule[] = [
	{
		triggers: ["startTime"],
		apply: ({ element, context }) => {
			const requestedStartTime =
				element.startTime < ZERO_MEDIA_TIME
					? ZERO_MEDIA_TIME
					: element.startTime;
			if (context.trackId !== context.tracks.main.id) {
				return {
					element: {
						...element,
						startTime: requestedStartTime,
					},
				};
			}

			const earliestElement = context.tracks.main.elements
				.filter((candidate) => candidate.id !== element.id)
				.reduce<TimelineElement | null>((earliest, candidate) => {
					if (!earliest || candidate.startTime < earliest.startTime) {
						return candidate;
					}
					return earliest;
				}, null);

			return {
				element: {
					...element,
					startTime:
						!earliestElement || requestedStartTime <= earliestElement.startTime
							? ZERO_MEDIA_TIME
							: requestedStartTime,
				},
			};
		},
	},
	{
		triggers: ["duration"],
		apply: ({ element, originalElement, patch, context }) => ({
			element: {
				...element,
				animations: clampAnimationsToDuration({
					animations: Object.hasOwn(patch, "animations") ? element.animations : animationsAfterLeftTrim({
						element: originalElement,
						patch,
						startTime: element.startTime,
						boundaryIdPrefix: context.boundaryIdPrefix,
					}),
					duration: element.duration,
					boundaryIdPrefix: context.boundaryIdPrefix,
				}),
			},
		}),
	},
];

export function applyElementUpdate({
	element,
	patch,
	context,
}: {
	element: TimelineElement;
	patch: Partial<TimelineElement>;
	context: ElementUpdateContext;
}): TimelineElement {
	let nextElement = {
		...element,
		...patch,
		params: {
			...element.params,
			...(patch.params ?? {}),
		},
	} as TimelineElement;
	const changedFields = new Set(
		Object.keys(patch) as ElementUpdateField[],
	);

	for (const rule of deriveRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		const result = rule.apply({
			element: nextElement,
			originalElement: element,
			patch,
			context,
		});
		nextElement = result.element;
		for (const field of result.changedFields ?? []) {
			changedFields.add(field);
		}
	}

	for (const rule of enforceRules) {
		if (!shouldApplyRule({ rule, changedFields })) {
			continue;
		}

		nextElement = rule.apply({
			element: nextElement,
			originalElement: element,
			patch,
			context,
		}).element;
	}

	return element.type === "text" && nextElement.type === "text"
		? reconcileCaptionEdit(element, nextElement) : nextElement;
}

function shouldApplyRule({
	rule,
	changedFields,
}: {
	rule: ElementUpdateRule;
	changedFields: Set<ElementUpdateField>;
}): boolean {
	return rule.triggers.some((trigger) => changedFields.has(trigger));
}

function getSourceDuration({
	trimStart,
	trimEnd,
	duration,
	sourceDuration,
	retime,
}: {
	trimStart: number;
	trimEnd: number;
	duration: number;
	sourceDuration?: number;
	retime?: RetimeConfig;
}): number {
	if (typeof sourceDuration === "number") {
		return sourceDuration;
	}

	return (
		trimStart +
		getSourceSpanAtClipTime({
			clipTime: duration,
			retime,
		}) +
		trimEnd
	);
}
