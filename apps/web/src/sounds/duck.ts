// Ducking as editable volume keyframes: find where the voice speaks, then lower the music there.
// The keyframes go on the music element (`path: "volume"`, dB), so the user can move or delete any of them.
// Pure functions; the server part that reads the voice audio is in duck-server.ts.

export type Segment = { start: number; end: number };
export type VolumeKeyframe = { path: "volume"; time: number; value: number };

/** RMS level in dBFS per frame of mono samples. */
export function frameLevels(samples: Float32Array, sampleRate: number, frameSeconds = 0.02): number[] {
	const size = Math.max(1, Math.round(sampleRate * frameSeconds));
	const levels: number[] = [];
	for (let i = 0; i < samples.length; i += size) {
		let sum = 0;
		const end = Math.min(samples.length, i + size);
		for (let j = i; j < end; j++) sum += samples[j] * samples[j];
		const rms = Math.sqrt(sum / Math.max(1, end - i));
		levels.push(rms > 0 ? 20 * Math.log10(rms) : -120);
	}
	return levels;
}

function percentile(sorted: number[], p: number): number {
	if (!sorted.length) return -120;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
}

export type SpeechOptions = {
	frameSeconds?: number;
	/** Level (dBFS) above which a frame counts as speech; automatic when omitted. */
	thresholdDb?: number;
	/** Pauses shorter than this stay inside one segment. */
	mergeGap?: number;
	/** Segments shorter than this are ignored (clicks, breaths). */
	minDuration?: number;
};

/**
 * Speech segments from frame levels. The automatic threshold sits between the quiet floor (10th
 * percentile) and the loud parts (95th percentile): at least 12 dB above the floor, at most 30 dB below the peaks.
 */
export function speechSegments(levels: number[], { frameSeconds = 0.02, thresholdDb, mergeGap = 0.3, minDuration = 0.12 }: SpeechOptions = {}): Segment[] {
	const sorted = [...levels].sort((a, b) => a - b);
	const floor = percentile(sorted, 0.1);
	// The loud level comes from frames clearly above the floor, so a short line in a long silence still
	// counts (the 95th percentile of all frames would be silence there).
	const loud = sorted.filter((level) => level > floor + 12);
	if (thresholdDb === undefined && loud.length * frameSeconds < minDuration) return [];
	const peak = loud.length ? percentile(loud, 0.9) : floor;
	const threshold = thresholdDb ?? Math.max(floor + 12, peak - 30, -60);
	const raw: Segment[] = [];
	let open: number | null = null;
	for (const [i, level] of levels.entries()) {
		if (level > threshold && open === null) open = i;
		if (level <= threshold && open !== null) {
			raw.push({ start: open * frameSeconds, end: i * frameSeconds });
			open = null;
		}
	}
	if (open !== null) raw.push({ start: open * frameSeconds, end: levels.length * frameSeconds });
	return mergeSegments(raw, mergeGap).filter((s) => s.end - s.start >= minDuration);
}

/** Sorted, with segments closer than `gap` joined. */
export function mergeSegments(segments: Segment[], gap = 0): Segment[] {
	const sorted = [...segments].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
	const merged: Segment[] = [];
	for (const s of sorted) {
		const last = merged.at(-1);
		if (last && s.start - last.end <= gap) last.end = Math.max(last.end, s.end);
		else merged.push({ ...s });
	}
	return merged;
}

export type DuckOptions = {
	/** Length of the music element (seconds); keyframes are relative to its start. */
	duration: number;
	/** Volume (dB) outside speech. */
	baseDb?: number;
	/** How much to lower the music during speech (dB, negative). */
	amountDb?: number;
	/** Seconds to fade down before speech starts. */
	attack?: number;
	/** Seconds to fade back up after speech ends. */
	release?: number;
};

/**
 * Volume keyframes that lower the music during `segments` (times relative to the music element).
 * Segments whose fades would overlap are joined, so the music stays down between close sentences.
 */
export function duckKeyframes(segments: Segment[], { duration, baseDb = 0, amountDb = -12, attack = 0.15, release = 0.5 }: DuckOptions): VolumeKeyframe[] {
	const low = baseDb + Math.min(0, amountDb);
	const inside = mergeSegments(
		segments.map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, s.end) })),
		attack + release,
	);
	if (!inside.length) return [];
	const lead = inside[0].start;
	const first = lead <= 0 ? low : lead >= attack ? baseDb : baseDb + ((low - baseDb) * (attack - lead)) / attack;
	const points: { time: number; value: number }[] = [{ time: 0, value: first }];
	// A zero attack or release is a step: the base value holds until 1 ms before the change.
	const STEP = 0.001;
	for (const s of inside) {
		const downAt = Math.max(0, s.start - Math.max(attack, STEP));
		if (downAt > 0) points.push({ time: downAt, value: baseDb });
		points.push({ time: s.start, value: low });
		points.push({ time: s.end, value: low });
		const upAt = Math.min(duration, s.end + Math.max(release, STEP));
		if (upAt > s.end) points.push({ time: upAt, value: baseDb });
	}
	const rounded = points.map((p) => ({ time: Math.round(p.time * 1000) / 1000, value: Math.round(p.value * 100) / 100 }));
	const unique = rounded.filter((p, i) => i === 0 || p.time > rounded[i - 1].time);
	return unique.map((p) => ({ path: "volume" as const, time: p.time, value: p.value }));
}
