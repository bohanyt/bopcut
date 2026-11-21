const FILTER_LOBES = 16;
const CUTOFF_MARGIN = 0.94;
const PHASES = 256;
const MAX_FILTERS = 8;
const MIN_SAMPLE_RATE = 8_000;

interface Filter {
	radius: number;
	weights: Float32Array;
}

const filters = new Map<number, Filter>();

/** Pad requests in source seconds before the decoder has reported its native rate. */
export function resamplePadding(sampleRate: number, speed = 1): number {
	return (FILTER_LOBES + 2) / (CUTOFF_MARGIN * Math.min(MIN_SAMPLE_RATE, sampleRate / speed));
}

function getFilter(step: number): Filter {
	const existing = filters.get(step);
	if (existing) return existing;

	const cutoff = CUTOFF_MARGIN / step;
	const radius = Math.ceil(FILTER_LOBES / cutoff);
	const taps = radius * 2 + 1;
	const weights = new Float32Array((PHASES + 1) * taps);
	for (let phase = 0; phase <= PHASES; phase++) {
		const offset = phase * taps;
		const fraction = phase / PHASES;
		let sum = 0;
		for (let tap = 0; tap < taps; tap++) {
			const distance = tap - radius - fraction;
			if (Math.abs(distance) >= radius) continue;
			const angle = Math.PI * distance * cutoff;
			const sinc = angle === 0 ? 1 : Math.sin(angle) / angle;
			const windowAngle = Math.PI * distance / radius;
			const window = 0.42 + 0.5 * Math.cos(windowAngle) + 0.08 * Math.cos(2 * windowAngle);
			const weight = sinc * window;
			weights[offset + tap] = weight;
			sum += weight;
		}
		for (let tap = 0; tap < taps; tap++) weights[offset + tap] /= sum;
	}

	if (filters.size === MAX_FILTERS) filters.delete(filters.keys().next().value!);
	const filter = { radius, weights };
	filters.set(step, filter);
	return filter;
}

/** Sample both channels at a fractional native frame, filtering before downsampling. */
export function createStereoSampler(buffer: AudioBuffer, step: number) {
	const left = buffer.getChannelData(0);
	const right = buffer.getChannelData(1);
	if (step <= 1) {
		return (position: number, result: Float64Array) => {
			const frame = Math.floor(position);
			const fraction = position - frame;
			result[0] = (left[frame] ?? 0) * (1 - fraction) + (left[frame + 1] ?? 0) * fraction;
			result[1] = (right[frame] ?? 0) * (1 - fraction) + (right[frame + 1] ?? 0) * fraction;
		};
	}

	const { radius, weights } = getFilter(step);
	const taps = radius * 2 + 1;
	return (position: number, result: Float64Array) => {
		const frame = Math.floor(position);
		const first = frame - radius;
		const phase = Math.round((position - frame) * PHASES);
		const offset = phase * taps;
		const from = Math.max(first, 0);
		const to = Math.min(first + taps, left.length);
		let sumLeft = 0;
		let sumRight = 0;
		for (let index = from, weight = offset + from - first; index < to; index++, weight++) {
			sumLeft += left[index] * weights[weight];
			sumRight += right[index] * weights[weight];
		}
		result[0] = sumLeft;
		result[1] = sumRight;
	};
}
