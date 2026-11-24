export type RangeInput = { from: number; to: number; rows: number };
export type RangeSpan = { start: number; end: number; label: string; text?: boolean };
export type RangeWords = { start: number; end: number; text: string; cutStart?: boolean; cutEnd?: boolean };
export const RANGE_WIDTH = 960;
export const RANGE_HEADER = 48;
export const RANGE_ROW_HEIGHT = 142;
export const RANGE_FRAME_WIDTH = 196;
export const RANGE_BUCKETS = 144;
export const MAX_RANGE_PNG = 8 * 1024 * 1024;

export function parseRangeInput({ from, to, rows = 8 }: Record<string, unknown>): RangeInput {
	if (typeof from !== "number" || typeof to !== "number" || !Number.isFinite(from) || !Number.isFinite(to) ||
		from < 0 || to > 7 * 86400 || to - from < 0.1 - 1e-9 || to - from > 120) {
		throw new Error("Pass --from and --to in seconds, for a range of 0.1–120 seconds.");
	}
	if (typeof rows !== "number" || !Number.isInteger(rows) || rows < 1 || rows > 12) {
		throw new Error("Set --rows to a whole number between 1 and 12.");
	}
	return { from, to, rows };
}

export const rangeRows = ({ from, to, rows }: RangeInput) => Array.from({ length: rows }, (_, index) => {
	const step = (to - from) / rows;
	return { from: from + step * index, to: index === rows - 1 ? to : from + step * (index + 1),
		time: from + step * (index + 0.5), y: RANGE_HEADER + RANGE_ROW_HEIGHT * index };
});

export function accumulatePeaks(peaks: Float32Array, pcm: Float32Array, offset: number, samples: number, channels = 1) {
	for (let i = 0; i < pcm.length; i++) {
		const bucket = Math.floor((offset + Math.floor(i / channels)) * peaks.length / samples);
		if (bucket >= peaks.length) break;
		const value = Math.abs(pcm[i]);
		if (Number.isFinite(value)) peaks[bucket] = Math.max(peaks[bucket], value);
	}
}

type Drawing = Pick<CanvasRenderingContext2D, "fillStyle" | "font" | "fillRect" | "fillText"> & {
	measureText(text: string): { width: number };
};
type Frame = (left: number, top: number, width: number, height: number) => void;
const stamp = (time: number) => time.toFixed(2) + "s";
const line = (label: string) => label.replace(/\s+/g, " ").trim();

/** Draws the same strip for project reviews and standalone files. Frame drawing is supplied by the caller. */
export function drawRangeView(ctx: Drawing, input: RangeInput, {
	title, frames, peaks, words, spans, intervals,
}: { title: string; frames: Frame[]; peaks: Float32Array; words: RangeWords[]; spans: RangeSpan[];
	intervals?: readonly { from: number; to: number; time: number }[] }) {
	const right = RANGE_WIDTH - 18;
	const left = RANGE_FRAME_WIDTH + 36;
	const width = right - left;
	const orderedWords = [...words].sort((a, b) => a.start - b.start);
	ctx.fillStyle = "#101722";
	ctx.fillRect(0, 0, RANGE_WIDTH, RANGE_HEADER + input.rows * RANGE_ROW_HEIGHT);
	ctx.fillStyle = "#eef4ff";
	ctx.font = "bold 17px sans-serif";
	ctx.fillText(`${line(title)}   •   ${stamp(input.from)}–${stamp(input.to)}`, 16, 29, RANGE_WIDTH - 32);

	for (const [i, row] of (intervals ?? rangeRows(input)).entries()) {
		const y = RANGE_HEADER + RANGE_ROW_HEIGHT * i;
		const at = (time: number) => left + (time - row.from) * width / (row.to - row.from);
		ctx.fillStyle = i % 2 === 0 ? "#192437" : "#151f2f";
		ctx.fillRect(8, y, RANGE_WIDTH - 16, RANGE_ROW_HEIGHT - 3);
		frames[i]?.(16, y + 6, RANGE_FRAME_WIDTH, 91);
		ctx.font = "12px sans-serif";
		ctx.fillStyle = "#c2d0e5";
		ctx.fillText(stamp(row.time), 16, y + 113);
		ctx.fillText(stamp(row.from), left, y + 17);
		ctx.fillText(stamp(row.to), right - 56, y + 17, 56);
		ctx.fillStyle = "#405575";
		ctx.fillRect(left, y + 39, width, 1);
		let peak = 0;
		for (let b = 0; b < RANGE_BUCKETS; b++) {
			const value = Math.min(1, peaks[i * RANGE_BUCKETS + b] || 0);
			peak = Math.max(peak, value);
			const amplitude = Math.sqrt(value) * 15;
			ctx.fillStyle = "#65d2bf";
			ctx.fillRect(left + b * width / RANGE_BUCKETS, y + 39 - amplitude, 2, amplitude * 2);
		}
		const rowSpans = spans.filter((span) => span.start < row.to && span.end > row.from);
		ctx.fillStyle = "#e6b668";
		for (const span of rowSpans) {
			for (const edge of [span.start, span.end]) {
				if (edge >= row.from && edge <= row.to) ctx.fillRect(at(edge), y + 23, 1, 46);
			}
		}
		const spoken = orderedWords.filter((word) => word.start < row.to && word.end > row.from);
		const laneRight = [left, left];
		ctx.fillStyle = "#eef4ff";
		ctx.font = "13px sans-serif";
		if (!spoken.length) ctx.fillText(peak < 0.003 ? "Quiet · no known words" : "No known words", left, y + 84, width);
		for (const word of spoken) {
			const x = at(Math.max(word.start, row.from));
			const end = at(Math.min(word.end, row.to));
			const startsHere = word.start >= row.from || i === 0;
			ctx.fillStyle = "#a0b5d3";
			ctx.fillRect(x, y + 63, Math.max(1, end - x), 1);
			if (startsHere) ctx.fillRect(x, y + 57, 1, 10);
			ctx.fillStyle = "#f0ab70";
			if (startsHere && (word.cutStart || word.start < input.from)) ctx.fillRect(x, y + 57, 3, 10);
			if ((word.end <= row.to && word.cutEnd) || (i === input.rows - 1 && word.end > input.to)) {
				ctx.fillRect(Math.max(x, end - 2), y + 57, 3, 10);
			}
			if (!startsHere) continue;
			const label = line(word.text);
			if (!label) continue;
			const labelWidth = ctx.measureText(label).width;
			const lane = laneRight.findIndex((after) => x >= after && x + labelWidth <= right);
			ctx.fillStyle = "#eef4ff";
			if (lane < 0) {
				ctx.fillText("•", x, y + 75);
			} else {
				ctx.fillText(label, x, y + 85 + lane * 16);
				laneRight[lane] = x + labelWidth + 7;
			}
		}
		ctx.font = "12px sans-serif";
		ctx.fillStyle = "#e6b668";
		ctx.fillText(rowSpans.filter((span) => !span.text).map((span) => line(span.label)).join(" / ").slice(0, 135),
			left, y + 118, width);
		ctx.fillStyle = "#b6ccf2";
		ctx.fillText(rowSpans.filter((span) => span.text).map((span) => line(span.label)).join(" / ").slice(0, 135),
			left, y + 134, width);
	}
}
