import type { FrameRate } from "opencut-wasm";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { frameRateToFloat } from "@/fps/utils";

/**
 * frame intervals for labels - starts at 2 so there's always at least
 * one tick between labels even at max zoom.
 * pattern: 2, 3, 5, 10, 15 (matches CapCut)
 */
const LABEL_FRAME_INTERVALS = [2, 3, 5, 10, 15] as const;

/**
 * frame intervals for ticks - can go down to 1 for max granularity.
 */
const TICK_FRAME_INTERVALS = [1, 2, 3, 5, 10, 15] as const;

/**
 * second intervals for when we're zoomed out past frame-level detail.
 */
const SECOND_MULTIPLIERS = [
	1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
] as const;

/**
 * sub-second tick intervals for whole-second labels when frames do not divide a second.
 */
const SUB_SECOND_TICKS = [0.1, 0.2, 0.25, 0.5] as const;

/**
 * minimum pixel spacing between labels to keep them readable
 */
const MIN_LABEL_SPACING_PX = 120;

/**
 * minimum pixel spacing between ticks. much denser than labels.
 */
const MIN_TICK_SPACING_PX = 18;

export interface RulerConfig {
	/** time interval in seconds between each label */
	labelIntervalSeconds: number;
	/** time interval in seconds between each tick */
	tickIntervalSeconds: number;
}

/**
 * determines the optimal label and tick intervals based on zoom level and FPS.
 *
 * labels and ticks scale independently:
 * - labels need wide spacing (~50px) to stay readable
 * - ticks can be denser (~8px) to show finer subdivisions
 *
 * example at different zoom levels:
 * - very zoomed in: labels every 2f, ticks every 1f
 * - zoomed in: labels every 10f, ticks every 1f
 * - zoomed out: labels every 15f, ticks every 3f
 * - very zoomed out: labels every 1s, ticks every 5f
 */
export function getRulerConfig({
	zoomLevel,
	fps,
}: {
	zoomLevel: number;
	fps: FrameRate;
}): RulerConfig {
	const fpsFloat = frameRateToFloat(fps);
	const pixelsPerSecond = BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel;
	const pixelsPerFrame = pixelsPerSecond / fpsFloat;

	const labelIntervalSeconds = findOptimalInterval({
		pixelsPerFrame,
		pixelsPerSecond,
		fps: fpsFloat,
		minSpacingPx: MIN_LABEL_SPACING_PX,
		frameIntervals: LABEL_FRAME_INTERVALS,
	});

	const rawTickIntervalSeconds = findOptimalInterval({
		pixelsPerFrame,
		pixelsPerSecond,
		fps: fpsFloat,
		minSpacingPx: MIN_TICK_SPACING_PX,
		frameIntervals: TICK_FRAME_INTERVALS,
	});

	// ensure tick interval divides evenly into label interval so labels always land on ticks
	const tickIntervalSeconds = ensureTickDividesLabel({
		tickIntervalSeconds: rawTickIntervalSeconds,
		labelIntervalSeconds,
		pixelsPerFrame,
		pixelsPerSecond,
		fps: fpsFloat,
	});

	return { labelIntervalSeconds, tickIntervalSeconds };
}

/**
 * adjusts tick interval to ensure it divides evenly into the label interval.
 * this guarantees labels always land on tick positions.
 */
function ensureTickDividesLabel({
	tickIntervalSeconds,
	labelIntervalSeconds,
	pixelsPerFrame,
	pixelsPerSecond,
	fps,
}: {
	tickIntervalSeconds: number;
	labelIntervalSeconds: number;
	pixelsPerFrame: number;
	pixelsPerSecond: number;
	fps: number;
}): number {
	// Compare in seconds: at 29.97 fps five frames do not divide a whole second, so ticks drawn at the
	// real frame interval would never reach the next second's label.
	const divides = (tick: number) => {
		const ratio = labelIntervalSeconds / tick;
		return Math.abs(ratio - Math.round(ratio)) < 1e-6;
	};

	// if tick already divides label evenly, we're good
	if (divides(tickIntervalSeconds)) {
		return tickIntervalSeconds;
	}

	// find the smallest tick interval that divides the label interval and has adequate spacing
	for (const candidateFrames of TICK_FRAME_INTERVALS) {
		if (divides(candidateFrames / fps)) {
			const candidateSpacing = pixelsPerFrame * candidateFrames;
			// accept if spacing meets minimum threshold
			if (candidateSpacing >= MIN_TICK_SPACING_PX) {
				return candidateFrames / fps;
			}
		}
	}

	// at 23.976, 29.97 and 59.94 fps no frame interval divides a whole second: split it evenly instead
	if (labelIntervalSeconds >= 1) {
		for (const candidateSeconds of SUB_SECOND_TICKS) {
			if (divides(candidateSeconds) && pixelsPerSecond * candidateSeconds >= MIN_TICK_SPACING_PX) {
				return candidateSeconds;
			}
		}
	}

	// try second-level tick intervals that divide the label interval cleanly
	for (const candidateSeconds of SECOND_MULTIPLIERS) {
		const ratio = labelIntervalSeconds / candidateSeconds;
		const isDivisor = Math.abs(ratio - Math.round(ratio)) < 0.0001;
		if (isDivisor) {
			const candidateSpacing = pixelsPerSecond * candidateSeconds;
			if (candidateSpacing >= MIN_TICK_SPACING_PX) {
				return candidateSeconds;
			}
		}
	}

	// fallback: use the label interval itself (no intermediate ticks)
	return labelIntervalSeconds;
}

function findOptimalInterval({
	pixelsPerFrame,
	pixelsPerSecond,
	fps,
	minSpacingPx,
	frameIntervals,
}: {
	pixelsPerFrame: number;
	pixelsPerSecond: number;
	fps: number;
	minSpacingPx: number;
	frameIntervals: readonly number[];
}): number {
	// try frame-level intervals first
	for (const frameInterval of frameIntervals) {
		const pixelSpacing = pixelsPerFrame * frameInterval;
		if (pixelSpacing >= minSpacingPx) {
			return frameInterval / fps;
		}
	}

	// then try second-level intervals
	for (const secondMultiplier of SECOND_MULTIPLIERS) {
		const pixelSpacing = pixelsPerSecond * secondMultiplier;
		if (pixelSpacing >= minSpacingPx) {
			return secondMultiplier;
		}
	}

	return 60;
}

/**
 * checks if a time should have a label based on the label interval.
 */
export function shouldShowLabel({
	time,
	labelIntervalSeconds,
}: {
	time: number;
	labelIntervalSeconds: number;
}): boolean {
	const epsilon = 0.0001;
	const remainder = time % labelIntervalSeconds;
	return remainder < epsilon || remainder > labelIntervalSeconds - epsilon;
}

/**
 * formats a ruler tick label on the project's frame grid.
 *
 * - a whole second, or the first frame after one: "MM:SS" (e.g., "00:00", "01:30")
 * - other frames: "Xf", counted from that first frame (e.g., "5f", "15f")
 */
export function formatRulerLabel({
	timeInSeconds,
	fps,
}: {
	timeInSeconds: number;
	fps: FrameRate;
}): string {
	// Whole-second ticks sit on their second even where it falls inside a frame (29.97 fps).
	const nearestSecond = Math.round(timeInSeconds);
	if (Math.abs(timeInSeconds - nearestSecond) < 1e-7) return formatTimestamp({ totalSeconds: nearestSecond });
	const { numerator, denominator } = fps;
	const frame = Math.round((timeInSeconds * numerator) / denominator);
	// Integer math: the frame just before a second is never within a tolerance of it.
	const second = Math.floor((frame * denominator) / numerator);
	const frameWithinSecond = frame - Math.ceil((second * numerator) / denominator);
	return frameWithinSecond === 0 ? formatTimestamp({ totalSeconds: second }) : `${frameWithinSecond}f`;
}

/**
 * formats a timestamp as MM:SS or H:MM:SS when >= 1 hour.
 */
function formatTimestamp({ totalSeconds }: { totalSeconds: number }): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	const mm = minutes.toString().padStart(2, "0");
	const ss = seconds.toString().padStart(2, "0");

	if (hours > 0) {
		return `${hours}:${mm}:${ss}`;
	}

	return `${mm}:${ss}`;
}
