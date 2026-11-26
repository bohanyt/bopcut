import { clampAnimationsToDuration, scaleAnimationTimes, splitAnimationsAtTime } from "@/animation";
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
import { TICKS_PER_SECOND, ZERO_MEDIA_TIME, mediaTime, roundFrameTicks, roundMediaTime, subMediaTime } from "@/wasm";
import type { FrameRate } from "opencut-wasm";
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
	fps,
}: ElementRef & {
	tracks: SceneTracks;
	retime?: RetimeConfig;
	rippleEnabled: boolean;
	boundaryIdPrefix: string;
	/** The project's frame rate: the new duration lands on its frame grid. */
	fps?: FrameRate;
}): SceneTracks | null {
	const track = findTrackInSceneTracks({ tracks, trackId });
	const element = track?.elements.find((candidate) => candidate.id === elementId);
	if (!track || !element || !isRetimableElement(element)) return tracks;

	const next = applyElementUpdate({
		element,
		patch: { retime },
		context: { tracks, trackId, boundaryIdPrefix, fps },
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
	/** Without it a retimed duration is only rounded to ticks. */
	fps?: FrameRate;
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
		apply: ({ element, originalElement, patch, context }) => {
			if (!("retime" in patch) || !isRetimableElement(element)) {
				return { element };
			}

			let nextRetime = patch.retime
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
			let nextDuration = roundMediaTime({
				time: getTimelineDurationForSourceSpan({
					sourceSpan: visibleSourceSpan,
					retime: nextRetime,
				}),
			});
			let trimEnd = element.trimEnd;
			if (context.fps && visibleSourceSpan > 0) {
				const onGrid = speedOnFrameGrid({
					fps: context.fps,
					duration: nextDuration,
					rate: nextRetime?.rate ?? 1,
					// The source after the clip's start that it may show: its trimmed tail too.
					availableSource: sourceDuration - element.trimStart,
				});
				nextDuration = mediaTime({ ticks: onGrid.duration });
				trimEnd = mediaTime({ ticks: onGrid.trimEnd });
				if (onGrid.rate !== (nextRetime?.rate ?? 1)) {
					nextRetime = { ...(nextRetime ?? { rate: 1 }), rate: onGrid.rate };
				}
			}

			// Keys stay on the same footage: from rate r1 to r2 each key time scales by r1 / r2.
			const previousRate = isRetimableElement(originalElement) ? originalElement.retime?.rate ?? 1 : 1;
			const animations = Object.hasOwn(patch, "animations")
				? element.animations
				: scaleAnimationTimes({ animations: element.animations, factor: previousRate / (nextRetime?.rate ?? 1) });

			return {
				element: {
					...element,
					retime: nextRetime,
					duration: nextDuration,
					trimEnd,
					animations,
				},
				changedFields: trimEnd === element.trimEnd
					? ["retime", "duration", "animations"]
					: ["retime", "duration", "trimEnd", "animations"],
			};
		},
	},
];

/**
 * Keys after a left-edge trim or extension (the patch keeps the right edge): they stay with the footage,
 * by the requested edge move. The main track can still move the clip to its start afterwards.
 */
function animationsAfterLeftTrim({
	element,
	patch,
	boundaryIdPrefix,
}: {
	element: TimelineElement;
	patch: Partial<TimelineElement>;
	boundaryIdPrefix?: string;
}): TimelineElement["animations"] {
	if (!element.animations || patch.startTime === undefined || patch.startTime === element.startTime ||
		patch.trimStart === undefined || patch.duration === undefined ||
		patch.startTime + patch.duration !== element.startTime + element.duration) {
		return element.animations;
	}
	const splitTime = subMediaTime({ a: patch.startTime, b: element.startTime });
	return splitAnimationsAtTime({
		animations: element.animations,
		splitTime,
		shouldIncludeSplitBoundary: splitTime > ZERO_MEDIA_TIME,
		boundaryIdPrefix,
	}).rightAnimations;
}

const enforceRules: ElementUpdateRule[] = [
	{
		triggers: ["duration"],
		apply: ({ element, originalElement, patch, context }) => {
			const leftTrimmed = Object.hasOwn(patch, "animations") ? undefined : animationsAfterLeftTrim({
				element: originalElement,
				patch,
				boundaryIdPrefix: context.boundaryIdPrefix,
			});
			// Keys an earlier rule already moved (a speed change) are kept unless this is a left trim.
			const animations = leftTrimmed === undefined || leftTrimmed === originalElement.animations ? element.animations : leftTrimmed;
			return {
				element: {
					...element,
					animations: clampAnimationsToDuration({
						animations,
						duration: element.duration,
						boundaryIdPrefix: context.boundaryIdPrefix,
					}),
				},
			};
		},
	},
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

/**
 * A speed change keeps the clip on the project's frame grid and at least one frame long. The rate
 * stays as asked: the duration goes to the nearest frame the source can fill, and the source left
 * over after it (a part of a frame) goes into the end trim. When even one frame needs more source
 * than there is, the rate is lowered until one frame fits.
 */
export function speedOnFrameGrid({ fps, duration, rate, availableSource }: {
	fps: FrameRate;
	/** The exact duration at the rate, in ticks. */
	duration: number;
	rate: number;
	/** The source after the clip's trimmed start, in ticks. */
	availableSource: number;
}): { duration: number; rate: number; trimEnd: number } {
	const frame = (TICKS_PER_SECOND * fps.denominator) / fps.numerator;
	const maxFrames = Math.floor(availableSource / rate / frame + 1e-9);
	if (maxFrames < 1) {
		const oneFrame = roundFrameTicks({ ticks: frame, fps });
		const fitted = clampRetimeRate({ rate: availableSource / oneFrame });
		return { duration: oneFrame, rate: fitted, trimEnd: Math.max(0, Math.round(availableSource - oneFrame * fitted)) };
	}
	const frames = Math.min(maxFrames, Math.max(1, Math.round(duration / frame)));
	const onGrid = roundFrameTicks({ ticks: frames * frame, fps });
	return { duration: onGrid, rate, trimEnd: Math.max(0, Math.round(availableSource - onGrid * rate)) };
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
