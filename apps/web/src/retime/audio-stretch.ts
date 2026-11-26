import { createStereoSampler, resamplePadding } from "@/media/audio-resample";
import { createAudioCheckpoint, STEREO_CHANNELS, type DecodedAudioWindow } from "@/media/audio-window";

type ReadWindow = (start: number, end: number) => Promise<DecodedAudioWindow | null>;

const GRAIN_RADIUS_SECONDS = 0.016;
const SEARCH_SECONDS = 0.007;
const BASS_SEARCH_SECONDS = 0.027;
const MATCH_RADIUS_SECONDS = 0.004;
const ATTACK_GUARD_SECONDS = 0.003;
const MAX_ATTACK_SECONDS = 0.0025;
const ATTACK_SILENCE = 0.0005;

interface Attack {
	start: number;
	peak: number;
	samples: Float32Array;
}

/** Keep brief attacks separated by silence out of the overlapping grains. */
function takeIsolatedAttacks(
	samples: Float32Array, guard: number, maxLength: number,
): Attack[] {
	const attacks: Attack[] = [];
	let start = -1;
	let last = -1;
	let peak = 0;
	let peakLevel = 0;
	for (let i = 0; i <= samples.length; i++) {
		if (i - last >= guard && start >= 0) {
			if (start >= guard && last - start < maxLength) {
				attacks.push({ start, peak, samples: samples.slice(start, last + 1) });
				samples.fill(0, start, last + 1);
			}
			start = -1;
			peakLevel = 0;
		}
		const level = i < samples.length ? Math.abs(samples[i]) : 0;
		if (level > ATTACK_SILENCE) {
			if (start < 0) start = i;
			last = i;
			if (level > peakLevel) {
				peak = i;
				peakLevel = level;
			}
		}
	}
	return attacks;
}

function interpolate(samples: Float32Array, frame: number, fraction: number): number {
	return samples[frame] + fraction * (samples[frame + 1] - samples[frame]);
}

/** Choose a nearby grain that continues the preceding waveform, using one shift for both channels. */
function alignGrain({
	left, right, nominal, reference, min, max, searchRadius, matchRadius, stride, referenceLeft, referenceRight,
}: {
	left: Float32Array;
	right: Float32Array;
	nominal: number;
	reference: number;
	min: number;
	max: number;
	searchRadius: number;
	matchRadius: number;
	stride: number;
	referenceLeft: Float32Array;
	referenceRight: Float32Array;
}): number {
	const first = Math.floor(reference) - matchRadius;
	const fraction = reference - Math.floor(reference);
	let referenceEnergy = 0;
	let differenceEnergy = 0;
	let peak = 0;
	for (let i = 0; i < referenceLeft.length; i++) {
		const frame = first + i * stride;
		const l = referenceLeft[i] = interpolate(left, frame, fraction);
		const r = referenceRight[i] = interpolate(right, frame, fraction);
		const energy = l * l + r * r;
		referenceEnergy += energy;
		peak = Math.max(peak, energy);
		if (i > 0) differenceEnergy += (l - referenceLeft[i - 1]) ** 2 + (r - referenceRight[i - 1]) ** 2;
	}
	// A sparse attack has no stable phase to match. Leave its grains on their time anchors.
	if (referenceEnergy <= 4 * peak) return nominal;

	const similarity = (center: number) => {
		let energy = 0;
		let dot = 0;
		for (let i = 0, frame = center - matchRadius; i < referenceLeft.length; i++, frame += stride) {
			const l = left[frame];
			const r = right[frame];
			energy += l * l + r * r;
			dot += l * referenceLeft[i] + r * referenceRight[i];
		}
		return energy > 0 ? dot / Math.sqrt(energy * referenceEnergy) : 0;
	};
	let best = nominal;
	let bestScore = 0.4;
	const score = (center: number) => {
		const candidate = similarity(center) - 0.0005 * Math.abs(center - nominal) / (max - min + 1);
		if (candidate <= bestScore) return;
		best = center;
		bestScore = candidate;
	};
	score(nominal);
	const nearMin = Math.max(min, nominal - searchRadius);
	const nearMax = Math.min(max, nominal + searchRadius);
	for (let center = nearMin; center <= nearMax; center += stride) score(center);
	// Bass can need more than the normal search radius to find a matching phase.
	if (bestScore < 0.999 && differenceEnergy < 0.01 * referenceEnergy) {
		for (let center = min; center < nearMin; center += stride) score(center);
		for (let center = nearMax + 1; center <= max; center += stride) score(center);
	}
	const coarse = best;
	for (let center = Math.max(min, coarse - stride + 1); center <= Math.min(max, coarse + stride - 1); center++) {
		score(center);
	}
	if (bestScore === 0.4 || best === min || best === max) return best;

	// Refine the correlation peak between samples to avoid accumulating a phase
	// error each hop when the pitch period falls between integer frames.
	const before = similarity(best - 1);
	const middle = similarity(best);
	const after = similarity(best + 1);
	const curvature = 2 * middle - before - after;
	return curvature > 0 ? best + Math.max(-0.5, Math.min(0.5, (after - before) / (2 * curvature))) : best;
}

/** Stretch short, overlapping PCM grains on a fixed output-time grid. */
export function createPitchReader({
	readWindow, sourceStart, sourceEnd, boundSourceEnd = true, readStart = sourceStart, rate, sampleRate,
	outputFrames = Math.max(0, Math.ceil((sourceEnd - readStart) / rate * sampleRate)), signal,
}: {
	readWindow: ReadWindow;
	sourceStart: number;
	sourceEnd: number;
	rate: number;
	sampleRate: number;
	boundSourceEnd?: boolean;
	readStart?: number;
	outputFrames?: number;
	signal?: AbortSignal;
}): (length: number) => Promise<AudioBuffer> {
	const inputFrames = Math.max(0, Math.ceil((sourceEnd - readStart) * sampleRate));
	// At higher speeds, space grains more closely to cover the source between hops.
	const hopSeconds = Math.min(0.006, 0.015 / rate);
	const radius = Math.ceil(GRAIN_RADIUS_SECONDS * sampleRate);
	const searchRadius = Math.ceil(SEARCH_SECONDS * sampleRate);
	const bassRadius = Math.ceil(BASS_SEARCH_SECONDS * sampleRate);
	const matchRadius = Math.ceil(MATCH_RADIUS_SECONDS * sampleRate);
	const attackGuard = Math.ceil(ATTACK_GUARD_SECONDS * sampleRate);
	const maxAttackLength = Math.ceil(MAX_ATTACK_SECONDS * sampleRate);
	// Classify each candidate with enough context to see both sides of an attack.
	const attackMargin = attackGuard + maxAttackLength;
	const stride = Math.max(1, Math.floor(sampleRate / 8_000));
	const matchLength = Math.ceil(2 * matchRadius / stride);
	const referenceLeft = new Float32Array(matchLength);
	const referenceRight = new Float32Array(matchLength);
	const padding = resamplePadding(sampleRate);
	const weights = Float32Array.from({ length: 2 * radius }, (_, i) =>
		(0.5 - 0.5 * Math.cos(Math.PI * i / radius)) ** 2,
	);
	// Keep a short resampled view of the current decode window so overlapping grains share samples.
	const pcmLength = Math.ceil(sampleRate / 8) + 2 * (radius + bassRadius + matchRadius + attackMargin);
	const inputLeft = new Float32Array(pcmLength);
	const inputRight = new Float32Array(pcmLength);
	const stereo = new Float64Array(STEREO_CHANNELS);
	let pcmStart = 0;
	let pcmEnd = 0;
	let decoded: DecodedAudioWindow | null = null;
	let decodedStart = 0;
	let decodedEnd = 0;
	let unavailable = false;
	let attacks: [Attack[], Attack[]] = [[], []];

	const ringLength = weights.length;
	const mixedLeft = new Float32Array(ringLength);
	const mixedRight = new Float32Array(ringLength);
	const attackLeft = new Float32Array(ringLength);
	const attackRight = new Float32Array(ringLength);
	const attackWeightLeft = new Float32Array(ringLength);
	const attackWeightRight = new Float32Array(ringLength);
	const gains = new Float32Array(ringLength);
	let frame = 0;
	let grainIndex = 0;
	let center = 0;
	let previousCenter = 0;
	let previousSource = 0;

	const loadPcm = async (from: number) => {
		pcmStart = from;
		pcmEnd = from + pcmLength;
		inputLeft.fill(0);
		inputRight.fill(0);
		attacks = [[], []];
		const first = Math.max(0, pcmStart);
		const last = Math.min(inputFrames, pcmEnd);
		if (last <= first) return;
		if (!decoded || first < decodedStart || last > decodedEnd) {
			decodedStart = first;
			decodedEnd = Math.min(inputFrames, first + sampleRate);
			decoded = await readWindow(readStart + first / sampleRate - padding,
				readStart + decodedEnd / sampleRate + padding);
			if (!decoded) {
				unavailable = true;
				return;
			}
		}
		const nativeRate = decoded.buffer.sampleRate;
		const nativeStart = Math.round(decoded.start * nativeRate);
		// The decode window includes interpolation padding. Limit taps to the clip's native samples.
		const sample = createStereoSampler(decoded.buffer, nativeRate / sampleRate, {
			start: Math.ceil(sourceStart * nativeRate - 1e-7) - nativeStart,
			end: boundSourceEnd ? Math.ceil(sourceEnd * nativeRate - 1e-7) - nativeStart : undefined,
		});
		const origin = (readStart - decoded.start) * nativeRate;
		for (let i = first; i < last; i++) {
			sample(origin + i * nativeRate / sampleRate, stereo);
			inputLeft[i - pcmStart] = stereo[0];
			inputRight[i - pcmStart] = stereo[1];
		}
		attacks = [
			takeIsolatedAttacks(inputLeft, attackGuard, maxAttackLength),
			takeIsolatedAttacks(inputRight, attackGuard, maxAttackLength),
		];
	};

	return async (length) => {
		const output = new AudioBuffer({ numberOfChannels: STEREO_CHANNELS, length, sampleRate });
		const left = output.getChannelData(0);
		const right = output.getChannelData(1);
		const checkpoint = createAudioCheckpoint(signal);
		const end = Math.min(outputFrames, frame + length);
		const start = frame;
		while (frame < end && inputFrames > 0 && !unavailable) {
			const pause = checkpoint();
			if (pause) await pause;
			if (center >= outputFrames || center - radius > frame) {
				const ready = Math.min(end, center >= outputFrames ? end : center - radius);
				for (; frame < ready; frame++) {
					const index = frame % ringLength;
					const gain = gains[index];
					left[frame - start] = (gain > 0 ? mixedLeft[index] / gain : 0) +
						(attackWeightLeft[index] > 0 ? attackLeft[index] / attackWeightLeft[index] : 0);
					right[frame - start] = (gain > 0 ? mixedRight[index] / gain : 0) +
						(attackWeightRight[index] > 0 ? attackRight[index] / attackWeightRight[index] : 0);
					mixedLeft[index] = mixedRight[index] = gains[index] = 0;
					attackLeft[index] = attackRight[index] = 0;
					attackWeightLeft[index] = attackWeightRight[index] = 0;
				}
				continue;
			}

			const nominal = Math.min(inputFrames - 1, Math.round(center * rate));
			const min = Math.max(0, nominal - bassRadius);
			const max = Math.min(inputFrames - 1, nominal + bassRadius);
			const reference = previousSource + center - previousCenter;
			const from = Math.min(min - radius, Math.floor(reference) - matchRadius) - attackMargin;
			const to = Math.max(max + radius, Math.ceil(reference) + matchRadius) + 1 + attackMargin;
			if (from < pcmStart || to > pcmEnd) await loadPcm(from);
			if (unavailable) break;

			const source = center === 0 || center === outputFrames - 1 ? nominal : pcmStart + alignGrain({
				left: inputLeft, right: inputRight,
				nominal: nominal - pcmStart, reference: reference - pcmStart,
				min: min - pcmStart, max: max - pcmStart, searchRadius, matchRadius, stride, referenceLeft, referenceRight,
			});
			// Normalize using only in-clip samples. A grain extending past the trim
			// contributes neither sound nor weight there, including at the two endpoints.
			const first = Math.max(frame, center - radius, center - Math.floor(source));
			const last = Math.min(outputFrames, center + radius, center + inputFrames - Math.ceil(source));
			const sourceFrame = Math.floor(source);
			const fraction = source - sourceFrame;
			for (let i = first; i < last; i++) {
				const index = i % ringLength;
				const weight = weights[i - center + radius];
				const input = i - center + sourceFrame - pcmStart;
				mixedLeft[index] += interpolate(inputLeft, input, fraction) * weight;
				mixedRight[index] += interpolate(inputRight, input, fraction) * weight;
				gains[index] += weight;
			}
			previousCenter = center;
			previousSource = source;
			const nextCenter = center === outputFrames - 1 ? outputFrames
				: Math.min(outputFrames - 1, Math.round(++grainIndex * hopSeconds * sampleRate));

			// Align the peak so resampler pre-ringing cannot move it past the cut.
			for (const [channel, channelAttacks] of attacks.entries()) {
				const attackMix = channel === 0 ? attackLeft : attackRight;
				const attackWeights = channel === 0 ? attackWeightLeft : attackWeightRight;
				for (const attack of channelAttacks) {
					const peak = Math.min(outputFrames - 1, Math.round((pcmStart + attack.peak) / rate));
					if (peak < center || peak >= nextCenter) continue;
					const onset = peak - (attack.peak - attack.start);
					const first = Math.max(frame, onset);
					const last = Math.min(outputFrames, onset + attack.samples.length);
					for (let i = first; i < last; i++) {
						const index = i % ringLength;
						const value = attack.samples[i - onset];
						// If two attacks collide after compression, blend without doubling their levels.
						attackMix[index] += value * Math.abs(value);
						attackWeights[index] += Math.abs(value);
					}
				}
			}
			center = nextCenter;
		}
		return output;
	};
}
