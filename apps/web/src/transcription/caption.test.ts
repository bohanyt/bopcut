import { describe, expect, test } from "bun:test";
import {
	DEFAULT_WORDS_PER_CAPTION,
	MIN_CAPTION_DURATION_SECONDS,
} from "./caption-defaults";
import { buildCaptionChunks } from "./caption";

describe("buildCaptionChunks", () => {
	test("proportional chunk times, overlaps, sort, invalid segments, slow segment", () => {
		const minDuration = MIN_CAPTION_DURATION_SECONDS;
		const sixWords = buildCaptionChunks({
			segments: [{ text: "one two three four five six", start: 0, end: 1.2 }],
			wordsPerChunk: 2,
			minDuration,
		});
		expect(sixWords.map((c) => c.startTime)).toEqual([0, 0.4, 0.8]);
		expect(sixWords[0]?.duration).toBeCloseTo(0.4);
		expect(sixWords[1]?.duration).toBeCloseTo(0.4);
		expect(sixWords[2]?.startTime).toBe(0.8);
		expect(sixWords[2]!.startTime + sixWords[2]!.duration).toBeCloseTo(
			0.8 + minDuration,
		);

		const overlap = buildCaptionChunks({
			segments: [
				{ text: "alpha beta gamma", start: 0, end: 2 },
				{ text: "delta epsilon", start: 1, end: 3 },
			],
			wordsPerChunk: 3,
			minDuration,
		});
		const firstEnd =
			overlap[0]!.startTime + overlap[0]!.duration;
		expect(overlap.find((c) => c.text.includes("delta"))?.startTime).toBe(1);
		expect(firstEnd).toBeCloseTo(1);

		const unsorted = buildCaptionChunks({
			segments: [
				{ text: "later words", start: 5, end: 7 },
				{ text: "early word", start: 0, end: 1 },
			],
			wordsPerChunk: 10,
			minDuration,
		});
		expect(unsorted.map((c) => c.startTime)).toEqual([0, 5]);

		const filtered = buildCaptionChunks({
			segments: [
				{ text: "ok", start: 0, end: 1 },
				{ text: "bad", start: 1, end: 1 },
				{ text: "rev", start: 3, end: 2 },
				{ text: "nan", start: Number.NaN, end: 1 },
				{ text: "   ", start: 0, end: 1 },
			],
			minDuration,
		});
		expect(filtered).toEqual([{ text: "ok", startTime: 0, duration: 1 }]);

		const slow = buildCaptionChunks({
			segments: [{ text: "one two three four five six", start: 0, end: 12 }],
			wordsPerChunk: DEFAULT_WORDS_PER_CAPTION,
			minDuration,
		});
		expect(slow).toEqual([
			{ text: "one two three", startTime: 0, duration: 6 },
			{ text: "four five six", startTime: 6, duration: 6 },
		]);
	});

	test("chunks of overlapping segments stay in order and never overlap", () => {
		const captions = buildCaptionChunks({
			segments: [
				{ text: "a b c d e f", start: 0, end: 3 },
				{ text: "u v w x y z", start: 0.5, end: 3.5 },
				{ text: "same", start: 3, end: 4 },
				{ text: "start", start: 3, end: 5 },
			],
			wordsPerChunk: 2,
			minDuration: 0.8,
		});
		expect(captions.map((c) => c.startTime)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3]);
		expect(captions.at(-1)?.text).toBe("same start");
		for (const [i, caption] of captions.entries()) {
			expect(caption.duration).toBeGreaterThan(0);
			const next = captions[i + 1];
			if (next) expect(caption.startTime + caption.duration).toBeLessThanOrEqual(next.startTime + 1e-9);
		}
	});
});
