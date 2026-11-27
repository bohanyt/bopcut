/**
 * Follows one point (a nose) through a run of small grey frames, the way the earlier nose tracker
 * did: a patch around the point in the first frame is looked for near its last place in every next
 * frame (normalised cross-correlation), so lighting changes do not throw it off. Where the best match
 * is weak (a hand in front, a cut) the point holds its last place and the sample is marked lost.
 */

/** One frame of grey values (0–255), row by row, at `time` seconds into the clip. */
export interface GrayFrame {
	time: number;
	width: number;
	height: number;
	data: Uint8Array | Uint8ClampedArray | Float32Array;
}

export interface TrackSample {
	time: number;
	x: number;
	y: number;
	/** The match's correlation, −1 to 1. */
	score: number;
	/** No good match: the point stayed where it was. */
	lost: boolean;
}

export interface TrackOptions {
	/** Half the patch's side, in frame pixels. */
	patch?: number;
	/** How far from its last place the point is looked for, in frame pixels. */
	search?: number;
	/** The weakest correlation still taken as the point. */
	minScore?: number;
	/** How much of a confident match goes into the patch (it follows slow changes of the face). */
	adapt?: number;
}

const DEFAULTS: Required<TrackOptions> = { patch: 6, search: 12, minScore: 0.6, adapt: 0.1 };

type Patch = { values: Float32Array; mean: number; norm: number; size: number };

function readPatch(frame: GrayFrame, cx: number, cy: number, half: number): Patch | null {
	const size = half * 2 + 1;
	if (cx - half < 0 || cy - half < 0 || cx + half >= frame.width || cy + half >= frame.height) return null;
	const values = new Float32Array(size * size);
	let sum = 0;
	for (let y = 0; y < size; y++) {
		const row = (cy - half + y) * frame.width + cx - half;
		for (let x = 0; x < size; x++) {
			const value = frame.data[row + x];
			values[y * size + x] = value;
			sum += value;
		}
	}
	const mean = sum / values.length;
	let squares = 0;
	for (let i = 0; i < values.length; i++) {
		values[i] -= mean;
		squares += values[i] * values[i];
	}
	return { values, mean, norm: Math.sqrt(squares), size };
}

/** Correlation of the patch with the frame around (cx, cy); null where the patch does not fit. */
function correlate(frame: GrayFrame, template: Patch, cx: number, cy: number): number | null {
	const half = (template.size - 1) / 2;
	if (cx - half < 0 || cy - half < 0 || cx + half >= frame.width || cy + half >= frame.height) return null;
	let sum = 0;
	for (let y = 0; y < template.size; y++) {
		const row = (cy - half + y) * frame.width + cx - half;
		for (let x = 0; x < template.size; x++) sum += frame.data[row + x];
	}
	const mean = sum / (template.size * template.size);
	let cross = 0, squares = 0;
	for (let y = 0; y < template.size; y++) {
		const row = (cy - half + y) * frame.width + cx - half;
		for (let x = 0; x < template.size; x++) {
			const value = frame.data[row + x] - mean;
			cross += value * template.values[y * template.size + x];
			squares += value * value;
		}
	}
	const denominator = Math.sqrt(squares) * template.norm;
	// A flat patch (no texture) matches nothing.
	return denominator > 1e-6 ? cross / denominator : 0;
}

/** Tracks from `seed` (in `frames[seed.index]`) forwards and backwards; one sample per frame, in time order. */
export function trackPoint({ frames, seed, options = {} }: {
	frames: GrayFrame[];
	seed: { index: number; x: number; y: number };
	options?: TrackOptions;
}): TrackSample[] {
	const { patch, search, minScore, adapt } = { ...DEFAULTS, ...options };
	const start = frames[seed.index];
	const seedX = Math.round(seed.x), seedY = Math.round(seed.y);
	const first = start && readPatch(start, seedX, seedY, patch);
	if (!first) return frames.map(({ time }) => ({ time, x: seed.x, y: seed.y, score: 0, lost: true }));

	const samples: TrackSample[] = new Array(frames.length);
	samples[seed.index] = { time: start.time, x: seedX, y: seedY, score: 1, lost: false };
	const run = (step: 1 | -1) => {
		const template = { ...first, values: first.values.slice() };
		let x = seedX, y = seedY;
		for (let index = seed.index + step; index >= 0 && index < frames.length; index += step) {
			const frame = frames[index];
			let best = -Infinity, bestX = x, bestY = y;
			// Every pixel of the search square: a sharp patch's peak is one pixel wide, so a coarser step misses it.
			for (let dy = -search; dy <= search; dy++) {
				for (let dx = -search; dx <= search; dx++) {
					const score = correlate(frame, template, x + dx, y + dy);
					if (score !== null && score > best) [best, bestX, bestY] = [score, x + dx, y + dy];
				}
			}
			const found = best >= minScore;
			if (found) {
				[x, y] = [bestX, bestY];
				const current = readPatch(frame, x, y, patch);
				if (current && adapt > 0) {
					let squares = 0;
					for (let i = 0; i < template.values.length; i++) {
						template.values[i] = template.values[i] * (1 - adapt) + current.values[i] * adapt;
						squares += template.values[i] * template.values[i];
					}
					template.norm = Math.sqrt(squares);
				}
			}
			samples[index] = { time: frame.time, x, y, score: Number.isFinite(best) ? best : 0, lost: !found };
		}
	};
	run(1);
	run(-1);
	return samples;
}

/**
 * Smooths a track over a window of `radius` samples on each side, leaving lost samples out of the
 * average, so a jittery match does not make the picture shake.
 */
export function smoothTrack(samples: TrackSample[], radius = 2): TrackSample[] {
	return samples.map((sample, index) => {
		let x = 0, y = 0, weight = 0;
		for (let offset = -radius; offset <= radius; offset++) {
			const other = samples[index + offset];
			if (!other || other.lost) continue;
			const w = radius + 1 - Math.abs(offset);
			x += other.x * w;
			y += other.y * w;
			weight += w;
		}
		return weight > 0 ? { ...sample, x: x / weight, y: y / weight } : sample;
	});
}

/**
 * The fewest samples whose straight lines stay within `tolerance` of the track (Ramer–Douglas–Peucker
 * on x and y against time): the keyframes of the path. The first and last samples are always kept.
 */
export function simplifyTrack(samples: TrackSample[], tolerance: number): TrackSample[] {
	if (samples.length <= 2) return samples.slice();
	const keep = new Uint8Array(samples.length);
	keep[0] = keep[samples.length - 1] = 1;
	const stack: [number, number][] = [[0, samples.length - 1]];
	while (stack.length) {
		const [from, to] = stack.pop()!;
		const a = samples[from], b = samples[to];
		const span = b.time - a.time || 1;
		let worst = -1, worstIndex = -1;
		for (let index = from + 1; index < to; index++) {
			const sample = samples[index];
			const t = (sample.time - a.time) / span;
			const error = Math.hypot(sample.x - (a.x + (b.x - a.x) * t), sample.y - (a.y + (b.y - a.y) * t));
			if (error > worst) [worst, worstIndex] = [error, index];
		}
		if (worst > tolerance) {
			keep[worstIndex] = 1;
			stack.push([from, worstIndex], [worstIndex, to]);
		}
	}
	return samples.filter((_, index) => keep[index]);
}
