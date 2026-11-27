import { expect, test } from "bun:test";
import { simplifyTrack, smoothTrack, trackPoint, type GrayFrame, type TrackSample } from "../point-track";

/** A small deterministic generator, so a failure repeats. */
function random(seed: number) {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
}

const W = 120, H = 90;
const next = random(3);
const background = Uint8Array.from({ length: W * H }, () => 60 + next() * 80);
// An uneven 13×13 pattern, like a nose with its shadow: a ring, a dark spot and a bright one.
const face = Array.from({ length: 13 * 13 }, (_, i) => {
	const x = (i % 13) - 6, y = Math.floor(i / 13) - 6;
	const r = Math.hypot(x, y);
	return r < 2 ? 230 : r < 4 ? 40 : x > 2 && y < -2 ? 255 : 150 + 10 * Math.sin(x * y);
});

function frame(time: number, at: { x: number; y: number } | null, noise = random(Math.round(time * 1000) + 7)): GrayFrame {
	const data = Uint8Array.from(background, (value) => Math.max(0, Math.min(255, value + (noise() - 0.5) * 10)));
	if (at) {
		for (let y = 0; y < 13; y++) for (let x = 0; x < 13; x++) data[(Math.round(at.y) - 6 + y) * W + Math.round(at.x) - 6 + x] = face[y * 13 + x];
	}
	return { time, width: W, height: H, data };
}
const path = (index: number) => ({ x: 30 + index * 1.5, y: 45 + 12 * Math.sin(index / 6) });

test("the point is followed forwards and backwards from a seed in the middle", () => {
	const frames = Array.from({ length: 40 }, (_, index) => frame(index / 10, path(index)));
	const samples = trackPoint({ frames, seed: { index: 20, ...path(20) } });
	expect(samples.map(({ time }) => time)).toEqual(frames.map(({ time }) => time));
	for (const [index, sample] of samples.entries()) {
		expect(sample.lost).toBe(false);
		expect(Math.hypot(sample.x - Math.round(path(index).x), sample.y - Math.round(path(index).y))).toBeLessThanOrEqual(1);
	}
});

test("a frame without the face holds the point and marks it lost; it is found again after", () => {
	const hidden = new Set([12, 13, 14]);
	const frames = Array.from({ length: 30 }, (_, index) => frame(index / 10, hidden.has(index) ? null : path(index)));
	const samples = trackPoint({ frames, seed: { index: 0, ...path(0) } });
	expect(samples.filter(({ lost }) => lost).map(({ time }) => Math.round(time * 10))).toEqual([12, 13, 14]);
	expect(samples[13]).toMatchObject({ x: samples[11].x, y: samples[11].y });
	for (const index of [15, 20, 29]) {
		expect(Math.hypot(samples[index].x - Math.round(path(index).x), samples[index].y - Math.round(path(index).y))).toBeLessThanOrEqual(1);
	}
});

test("a seed whose patch leaves the frame tracks nothing", () => {
	const frames = [frame(0, path(0)), frame(0.1, path(1))];
	expect(trackPoint({ frames, seed: { index: 0, x: 2, y: 2 } }).every(({ lost }) => lost)).toBe(true);
});

const sample = (time: number, x: number, y = 0, lost = false): TrackSample => ({ time, x, y, score: 1, lost });

test("smoothing evens out jitter and leaves lost samples out", () => {
	const jittery = Array.from({ length: 20 }, (_, index) => sample(index, 50 + (index % 2 ? 2 : -2)));
	const smooth = smoothTrack(jittery, 2);
	const spread = (samples: TrackSample[]) => Math.max(...samples.slice(2, -2).map(({ x }) => x)) - Math.min(...samples.slice(2, -2).map(({ x }) => x));
	expect(spread(smooth)).toBeLessThan(spread(jittery) / 3);
	const withLost = [sample(0, 10), sample(1, 900, 0, true), sample(2, 12)];
	expect(smoothTrack(withLost, 1)[1].x).toBeCloseTo(11, 9);
});

test("a path becomes the few keyframes that stay within the tolerance", () => {
	const line = Array.from({ length: 50 }, (_, index) => sample(index, index * 2, index));
	expect(simplifyTrack(line, 0.5).map(({ time }) => time)).toEqual([0, 49]);
	const corner = Array.from({ length: 41 }, (_, index) => sample(index, index <= 20 ? index : 40 - index));
	expect(simplifyTrack(corner, 0.5).map(({ time }) => time)).toEqual([0, 20, 40]);
	const wave = Array.from({ length: 100 }, (_, index) => sample(index, 20 * Math.sin(index / 10)));
	const keys = simplifyTrack(wave, 1);
	expect(keys.length).toBeLessThan(25);
	// Between keys the line stays within the tolerance of the path.
	for (let index = 0; index < wave.length; index++) {
		const after = keys.findIndex((key) => key.time >= index);
		const b = keys[after], a = keys[Math.max(0, after - 1)];
		const t = b.time === a.time ? 0 : (index - a.time) / (b.time - a.time);
		expect(Math.abs(wave[index].x - (a.x + (b.x - a.x) * t))).toBeLessThanOrEqual(1 + 1e-9);
	}
});
