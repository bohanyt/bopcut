export type Severity = "error" | "warning" | "info";
export type ReviewFinding = {
	kind: string; severity: Severity; from: number; to: number; elementIds: string[];
	values: Record<string, number | string | boolean | null>; picture?: string;
};

// All times are seconds. Limits leave room for intentional short-form effects.
export const REVIEW_LIMITS = {
	blackFraction: 0.98, blackSeconds: 0.25, // Ignore brief transitions.
	freezeSeconds: 0.75, freezeMeanDelta: 0.5, sourceMeanDelta: 8, // Require visible movement in the source.
	silenceDb: -50, silenceSeconds: 0.5, // Only unusually quiet tails and heads.
	loudnessLow: -24, loudnessHigh: -8, truePeak: 0, // Broad delivery limits, no mixing target.
	popSeconds: 0.01, popNeighbors: 0.02, popDeltaDb: 12, popPeakDb: -18, // A transient must stand out on both sides.
	clippedWordSeconds: 0.06, // Ignore small differences in stored word timings.
	pauseRatio: 2, pauseDelta: 0.25, // Compare with local speech instead of a global cadence.
	margin: 0.02, overlayBottom: 0.18, overlayRight: 0.12, overlayTop: 0.08,
	phoneTextPx: 12, portraitWidth: 360, landscapeWidth: 640,
	readCharsPerSecond: 15, minReadSeconds: 0.7,
	overlap: 0.10, cover: 0.90, layeredBox: 0.90,
	repeatFraction: 0.95, repeatSeconds: 0.5, nearbyRepeatSeconds: 10,
};

export const finding = (kind: string, severity: Severity, from: number, to: number, values: ReviewFinding["values"], elementIds: string[] = []): ReviewFinding =>
	({ kind, severity, from, to, elementIds, values });
export const decibels = (amplitude: number) => 20 * Math.log10(Math.max(1e-6, amplitude));
export function meanDelta(a: Uint8Array, b: Uint8Array) {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
	return sum / a.length;
}

export function cutPop(samples: Float32Array, rate: number, center: number, channels = 1) {
	const n = Math.floor(samples.length / channels);
	const half = Math.round(rate * REVIEW_LIMITS.popSeconds / 2);
	const wing = Math.round(rate * REVIEW_LIMITS.popNeighbors);
	const peak = (from: number, to: number) => {
		let maximum = 0;
		for (let i = from * channels; i < to * channels; i++) maximum = Math.max(maximum, Math.abs(samples[i]));
		return decibels(maximum);
	};
	if (center < half + wing || center + half + wing > n) return null;
	const left = peak(center - half - wing, center - half);
	const right = peak(center + half, center + half + wing);
	const hit = peak(center - half, center + half);
	return hit > REVIEW_LIMITS.popPeakDb && hit - Math.max(left, right) >= REVIEW_LIMITS.popDeltaDb
		? { peakDb: hit, beforeDb: left, afterDb: right, deltaDb: hit - Math.max(left, right), maximumSeconds: REVIEW_LIMITS.popSeconds } : null;
}

export function unusualPauses(spans: { from: number; to: number }[]) {
	const gaps: { from: number; to: number; seconds: number }[] = [];
	let spokenEnd = spans[0]?.to ?? 0;
	for (const span of spans.slice(1)) {
		if (span.from > spokenEnd) gaps.push({ from: spokenEnd, to: span.from, seconds: span.from - spokenEnd });
		spokenEnd = Math.max(spokenEnd, span.to);
	}
	return gaps.flatMap((gap, index) => {
		const nearby = gaps.slice(Math.max(0, index - 3), index + 4).filter((other) => other !== gap).map((other) => other.seconds).sort((a, b) => a - b);
		if (nearby.length < 3) return [];
		const median = (nearby[(nearby.length - 1) >> 1] + nearby[nearby.length >> 1]) / 2;
		const ratio = gap.seconds / median;
		return Math.abs(gap.seconds - median) >= REVIEW_LIMITS.pauseDelta &&
			(ratio >= REVIEW_LIMITS.pauseRatio || ratio <= 1 / REVIEW_LIMITS.pauseRatio)
			? [finding("unusual-pause", "info", gap.from, gap.to, { seconds: gap.seconds, localMedian: median, ratio, thresholdRatio: REVIEW_LIMITS.pauseRatio })] : [];
	});
}

export function summarizeReview(report: string, findings: ReviewFinding[], skipped: string[]) {
	const counts = { error: 0, warning: 0, info: 0 };
	const groups = new Map<string, { kind: string; severity: Severity; count: number; times: number[] }>();
	for (const hit of findings) {
		counts[hit.severity]++;
		const key = hit.severity + hit.kind;
		const group = groups.get(key) ?? { kind: hit.kind, severity: hit.severity, count: 0, times: [] };
		group.count++;
		if (group.times.length < 3) group.times.push(Math.round(hit.from * 1000) / 1000);
		groups.set(key, group);
	}
	const order = { error: 0, warning: 1, info: 2 };
	const entries = [...groups.values()].sort((a, b) => Number(b.kind === "stale-export") - Number(a.kind === "stale-export") ||
		order[a.severity] - order[b.severity] || a.times[0] - b.times[0]);
	const stale = entries.some((entry) => entry.kind === "stale-export");
	const summary = { report, ...(stale && { notice: "The export is stale. All other findings may be off." }),
		counts, clean: counts.error + counts.warning === 0, skipped, findings: entries.slice(0, 25), omittedGroups: 0 };
	while (Buffer.byteLength(JSON.stringify(summary)) >= 3800 && summary.findings.length) summary.findings.pop();
	summary.omittedGroups = entries.length - summary.findings.length;
	return summary;
}
