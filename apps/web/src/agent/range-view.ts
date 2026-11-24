export type RangeInput = { from: number; to: number; rows: number };
export type RangeSpan = { start: number; end: number; label: string; text?: boolean };
export type RangeWords = { start: number; end: number; text: string };
export const RANGE_WIDTH = 960;
export const RANGE_HEADER = 48;
export const RANGE_ROW_HEIGHT = 122;
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

export function accumulatePeaks(peaks: Float32Array, channel: Float32Array, offset: number, samples: number) {
	for (let i = 0; i < channel.length; i++) {
		const bucket = Math.floor((offset + i) * peaks.length / samples);
		if (bucket >= peaks.length) break;
		const value = Math.abs(channel[i]);
		if (Number.isFinite(value)) peaks[bucket] = Math.max(peaks[bucket], value);
	}
}

type Drawing = Pick<CanvasRenderingContext2D, "fillStyle" | "font" | "fillRect" | "fillText">;
type Frame = (left: number, top: number, width: number, height: number) => void;
const stamp = (time: number) => time.toFixed(2) + "s";
const line = (label: string) => label.replace(/\s+/g, " ").trim();

/** Draws the same strip for project reviews and standalone files. Frame drawing is supplied by the caller. */
export function drawRangeView(ctx: Drawing, input: RangeInput, {
	title, frames, peaks, words, spans,
}: { title: string; frames: Frame[]; peaks: Float32Array; words: RangeWords[]; spans: RangeSpan[] }) {
	const right = RANGE_WIDTH - 18;
	const left = RANGE_FRAME_WIDTH + 36;
	const width = right - left;
	ctx.fillStyle = "#101722";
	ctx.fillRect(0, 0, RANGE_WIDTH, RANGE_HEADER + input.rows * RANGE_ROW_HEIGHT);
	ctx.fillStyle = "#eef4ff";
	ctx.font = "bold 17px sans-serif";
	ctx.fillText(`${line(title)}   •   ${stamp(input.from)}–${stamp(input.to)}`, 16, 29, RANGE_WIDTH - 32);

	for (const [i, row] of rangeRows(input).entries()) {
		const { y } = row;
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
				if (edge >= row.from && edge <= row.to) ctx.fillRect(at(edge), y + 23, 1, 33);
			}
		}
		const spoken = words.filter((word) => word.start < row.to && word.end > input.from &&
			Math.max(word.start, input.from) >= row.from);
		ctx.fillStyle = "#eef4ff";
		ctx.font = "14px sans-serif";
		ctx.fillText(spoken.length ? spoken.map((word) => line(word.text)).join(" ").slice(0, 150)
			: peak < 0.003 ? "Quiet · no known words" : "No known words", left, y + 76, width);
		ctx.font = "12px sans-serif";
		ctx.fillStyle = "#e6b668";
		ctx.fillText(rowSpans.filter((span) => !span.text).map((span) => line(span.label)).join(" / ").slice(0, 135),
			left, y + 95, width);
		ctx.fillStyle = "#b6ccf2";
		ctx.fillText(rowSpans.filter((span) => span.text).map((span) => line(span.label)).join(" / ").slice(0, 135),
			left, y + 111, width);
	}
}
