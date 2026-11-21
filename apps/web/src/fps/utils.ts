import type { FrameRate } from "opencut-wasm";
import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND } from "@/wasm/media-time";

type MediaAssetFpsInput = Pick<MediaAsset, "type" | "fps">;

const STANDARD_FRAME_RATES: Array<{ value: number; rate: FrameRate }> = [
	{ value: 24_000 / 1_001, rate: { numerator: 24_000, denominator: 1_001 } },
	{ value: 24, rate: { numerator: 24, denominator: 1 } },
	{ value: 25, rate: { numerator: 25, denominator: 1 } },
	{ value: 30_000 / 1_001, rate: { numerator: 30_000, denominator: 1_001 } },
	{ value: 30, rate: { numerator: 30, denominator: 1 } },
	{ value: 48, rate: { numerator: 48, denominator: 1 } },
	{ value: 50, rate: { numerator: 50, denominator: 1 } },
	{ value: 60_000 / 1_001, rate: { numerator: 60_000, denominator: 1_001 } },
	{ value: 60, rate: { numerator: 60, denominator: 1 } },
	{ value: 120, rate: { numerator: 120, denominator: 1 } },
];

const STANDARD_FRAME_RATE_TOLERANCE = 0.01;

export function frameRateToFloat(rate: FrameRate): number {
	return rate.numerator / rate.denominator;
}

export function frameRateHasWholeTicks({ numerator, denominator }: FrameRate): boolean {
	return numerator > 0 && denominator > 0 && (TICKS_PER_SECOND * denominator) % numerator === 0;
}

export function frameRatesEqual({
	a,
	b,
}: {
	a: FrameRate;
	b: FrameRate;
}): boolean {
	return a.numerator === b.numerator && a.denominator === b.denominator;
}

export function floatToFrameRate(fps: number): FrameRate {
	const standard = STANDARD_FRAME_RATES.find(
		(candidate) => Math.abs(fps - candidate.value) <= STANDARD_FRAME_RATE_TOLERANCE,
	);
	if (standard) return standard.rate;

	if (Number.isInteger(fps)) {
		return { numerator: fps, denominator: 1 };
	}

	const ARBITRARY_DENOMINATOR = 1_000_000;
	const scaledNumerator = Math.round(fps * ARBITRARY_DENOMINATOR);
	const divisor = gcd({
		left: scaledNumerator,
		right: ARBITRARY_DENOMINATOR,
	});
	return {
		numerator: scaledNumerator / divisor,
		denominator: ARBITRARY_DENOMINATOR / divisor,
	};
}

export function importedVideoProjectRate(fps: number): FrameRate | null {
	if (!Number.isFinite(fps) || fps <= 0 || fps > TICKS_PER_SECOND) return null;
	const rate = floatToFrameRate(fps);
	// Both the source frame grid and the nominal clock used for frame timecode must be exact.
	if (
		rate.numerator <= 0xffffffff && frameRateHasWholeTicks(rate) &&
		TICKS_PER_SECOND % Math.ceil(frameRateToFloat(rate)) === 0
	) {
		return rate;
	}

	// Preserve supported legacy rounded rates outside the usual footage range.
	if (fps < STANDARD_FRAME_RATES[0].value || fps > STANDARD_FRAME_RATES.at(-1)!.value) {
		const rounded = Math.round(fps);
		return TICKS_PER_SECOND % rounded === 0 ? { numerator: rounded, denominator: 1 } : null;
	}

	return STANDARD_FRAME_RATES.reduce((closest, candidate) =>
		Math.abs(fps - candidate.value) < Math.abs(fps - closest.value) ? candidate : closest,
	).rate;
}

function gcd({ left, right }: { left: number; right: number }): number {
	let a = Math.abs(left);
	let b = Math.abs(right);
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a || 1;
}

export function getHighestImportedVideoFps({
	mediaAssets,
}: {
	mediaAssets: MediaAssetFpsInput[];
}): number | null {
	let highestFps: number | null = null;

	for (const asset of mediaAssets) {
		const fps = asset.fps ?? Number.NaN;
		if (asset.type !== "video") continue;
		if (!Number.isFinite(fps) || fps <= 0) continue;

		highestFps = highestFps === null ? fps : Math.max(highestFps, fps);
	}

	return highestFps;
}

export function getRaisedProjectFpsForImportedMedia({
	currentFps,
	importedAssets,
}: {
	currentFps: FrameRate;
	importedAssets: MediaAssetFpsInput[];
}): FrameRate | null {
	let highest = currentFps;
	for (const { type, fps } of importedAssets) {
		if (type !== "video" || fps === undefined) continue;
		const rate = importedVideoProjectRate(fps);
		if (rate && frameRateToFloat(rate) > frameRateToFloat(highest)) highest = rate;
	}
	return highest === currentFps ? null : highest;
}
