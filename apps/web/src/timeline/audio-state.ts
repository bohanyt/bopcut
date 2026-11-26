import { hasKeyframesForPath } from "@/animation/keyframe-query";
import { resolveNumberAtTime } from "@/animation/values";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";
import { VOLUME_DB_MAX, VOLUME_DB_MIN } from "./audio-constants";
import type { TimelineElement } from "./types";

const DEFAULT_STEP_SECONDS = 1 / 60;
const audioFadeWindow = Symbol("audioFadeWindow");

export type AudioCapableElement = Extract<
	TimelineElement,
	{ type: "audio" | "video" }
> & {
	[audioFadeWindow]?: { offsetTicks: number; duration: MediaTime };
};

/** Keeps the original fade window on a mixer-only clip cut by a compound. */
export function keepAudioFadeTiming({
	original,
	clipped,
}: {
	original: AudioCapableElement;
	clipped: AudioCapableElement;
}): AudioCapableElement {
	if (clipped === original) return clipped;
	const fadeWindow = original[audioFadeWindow];
	return {
		...clipped,
		[audioFadeWindow]: {
			offsetTicks: (fadeWindow?.offsetTicks ?? 0) + (clipped.startTime - original.startTime),
			duration: fadeWindow?.duration ?? original.duration,
		},
	};
}

export function clampDb(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}

	return Math.min(VOLUME_DB_MAX, Math.max(VOLUME_DB_MIN, value));
}

export function dBToLinear(db: number): number {
	return 10 ** (clampDb(db) / 20);
}

export function getElementVolume({
	element,
}: {
	element: AudioCapableElement;
}): number {
	const value = element.params.volume;
	return typeof value === "number" ? value : 0;
}

export function isElementMuted({
	element,
}: {
	element: AudioCapableElement;
}): boolean {
	return element.params.muted === true;
}

/** Fade-in and fade-out lengths (seconds) of an audio-capable clip; 0 when unset. */
export function getElementFades({
	element,
}: {
	element: AudioCapableElement;
}): { fadeIn: number; fadeOut: number } {
	const read = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) && value > 0
			? value
			: 0;
	return {
		fadeIn: read(element.params.fadeIn),
		fadeOut: read(element.params.fadeOut),
	};
}

/**
 * Linear gain of the clip's fades at `localTime` (seconds from the clip start): rises from 0 over
 * `fadeIn`, falls to 0 over the last `fadeOut` seconds of the clip, 1 in between.
 */
export function fadeGainAt({
	element,
	localTime,
}: {
	element: AudioCapableElement;
	localTime: number;
}): number {
	const { fadeIn, fadeOut } = getElementFades({ element });
	if (!fadeIn && !fadeOut) return 1;
	const fadeWindow = element[audioFadeWindow];
	const duration = (fadeWindow?.duration ?? element.duration) / TICKS_PER_SECOND;
	const fadeTime = localTime + (fadeWindow?.offsetTicks ?? 0) / TICKS_PER_SECOND;
	let gain = 1;
	if (fadeIn > 0) gain *= Math.min(1, Math.max(0, fadeTime / fadeIn));
	if (fadeOut > 0)
		gain *= Math.min(1, Math.max(0, (duration - fadeTime) / fadeOut));
	return gain;
}

/** True when the clip's volume has keyframes (fades alone do not count). */
export function hasVolumeKeyframes({
	element,
}: {
	element: AudioCapableElement;
}): boolean {
	return hasKeyframesForPath({
		animations: element.animations,
		propertyPath: "volume",
	});
}

/** True when the clip's gain changes over time: volume keyframes or fades. */
export function hasAnimatedVolume({
	element,
}: {
	element: AudioCapableElement;
}): boolean {
	const { fadeIn, fadeOut } = getElementFades({ element });
	return (
		fadeIn > 0 ||
		fadeOut > 0 ||
		hasKeyframesForPath({
			animations: element.animations,
			propertyPath: "volume",
		})
	);
}

export function resolveEffectiveAudioGain({
	element,
	trackMuted = false,
	localTime,
}: {
	element: AudioCapableElement;
	trackMuted?: boolean;
	localTime: number;
}): number {
	if (trackMuted || isElementMuted({ element })) {
		return 0;
	}

	const resolvedDb = resolveNumberAtTime({
		baseValue: getElementVolume({ element }),
		animations: element.animations,
		propertyPath: "volume",
		localTime: Math.round(localTime * TICKS_PER_SECOND),
	});

	return dBToLinear(resolvedDb) * fadeGainAt({ element, localTime });
}

export function buildWaveformGainSamples({
	element,
	count,
}: {
	element: AudioCapableElement;
	count: number;
}): number[] {
	const durationSeconds = element.duration / TICKS_PER_SECOND;
	return Array.from({ length: count }, (_, i) => {
		const localTime = ((i + 0.5) / count) * durationSeconds;
		return resolveEffectiveAudioGain({ element, localTime });
	});
}

export function buildAudioGainAutomation({
	element,
	trackMuted = false,
	fromLocalTime,
	toLocalTime,
	stepSeconds = DEFAULT_STEP_SECONDS,
}: {
	element: AudioCapableElement;
	trackMuted?: boolean;
	fromLocalTime: number;
	toLocalTime: number;
	stepSeconds?: number;
}): Array<{ localTime: number; gain: number }> {
	const startTime = Math.max(0, fromLocalTime);
	const endTime = Math.max(startTime, toLocalTime);
	const safeStep =
		Number.isFinite(stepSeconds) && stepSeconds > 0
			? stepSeconds
			: DEFAULT_STEP_SECONDS;
	const points: Array<{ localTime: number; gain: number }> = [];

	for (let localTime = startTime; localTime < endTime; localTime += safeStep) {
		points.push({
			localTime,
			gain: resolveEffectiveAudioGain({
				element,
				trackMuted,
				localTime,
			}),
		});
	}
	// Exact points where fades start and end, so a fade shorter than a step still lands on time.
	const { fadeIn, fadeOut } = getElementFades({ element });
	const fadeWindow = element[audioFadeWindow];
	const duration = (fadeWindow?.duration ?? element.duration) / TICKS_PER_SECOND;
	const offset = (fadeWindow?.offsetTicks ?? 0) / TICKS_PER_SECOND;
	const fadeEdges = [
		fadeIn > 0 ? fadeIn - offset : undefined,
		fadeOut > 0 ? duration - fadeOut - offset : undefined,
	];
	for (const edge of fadeEdges) {
		if (edge !== undefined && edge > startTime && edge < endTime && !points.some((p) => Math.abs(p.localTime - edge) < 1e-6)) {
			points.push({ localTime: edge, gain: resolveEffectiveAudioGain({ element, trackMuted, localTime: edge }) });
		}
	}
	points.sort((a, b) => a.localTime - b.localTime);

	points.push({
		localTime: endTime,
		gain: resolveEffectiveAudioGain({
			element,
			trackMuted,
			localTime: endTime,
		}),
	});

	return points;
}
