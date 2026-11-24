import { expect, test } from "bun:test";
import { audio, fixture, scene, t } from "@/timeline/__tests__/compound-fixtures";
import type { CompoundElement } from "@/timeline";
import { mapPhrases, packTranscript, timelineTranscript, type TranscriptClip } from "./packed-transcript";
import { accumulatePeaks, drawRangeView, parseRangeInput, RANGE_BUCKETS, RANGE_HEADER, RANGE_ROW_HEIGHT, RANGE_WIDTH, rangeRows } from "./range-view";

test("phrases split at half a second and retain both axes through a cut and retime", () => {
	const results = mapPhrases([
		{ text: "cut out", start: 0, end: 1 },
		{ text: "edge", start: 1.5, end: 2.5 },
		{ text: "word", start: 3, end: 3.5 },
		{ text: "later", start: 4.5, end: 6 },
		{ text: "outside", start: 6, end: 7 },
	], 10, 12, 2, 2);
	expect(results).toEqual([
		{ start: 10, end: 10.75, sourceStart: 2, sourceEnd: 3.5, text: "edge word" },
		{ start: 11.25, end: 12, sourceStart: 4.5, sourceEnd: 6, text: "later" },
	]);
});

test("overlapping root tracks and trimmed nested audio share time while muted tracks disappear", () => {
	const [root] = fixture();
	const compound: CompoundElement = { ...root.tracks.main.elements[0], type: "compound", id: "compound",
		sceneId: "nested", startTime: t(10), duration: t(2), trimStart: t(2), sourceDuration: t(6) };
	root.tracks.main.elements = [compound];
	root.tracks.audio[0].elements = [audio("host", 10.5, 3)];
	const nested = scene("nested", { ...root.tracks, overlay: [], main: { ...root.tracks.main, elements: [] }, audio: [
		{ id: "nested-audio", name: "Voices", type: "audio", muted: false, elements: [
			{ ...audio("nested", 1, 4), trimStart: t(1), retime: { rate: 2 } },
		] },
		{ id: "muted", name: "Muted", type: "audio", muted: true, elements: [audio("muted", 1, 4)] },
	] }, { kind: "compound" });
	const clips = timelineTranscript(root, [root, nested], [
		{ id: "media-nested", name: "Source", words: [{ text: "nested", start: 3, end: 4 }] },
		{ id: "media-host", name: "Host source" },
	]);
	expect(clips.map(({ name }) => name)).toEqual(["nested", "host"]);
	expect(clips[0].phrases).toEqual([{ start: 10, end: 10.5, sourceStart: 3, sourceEnd: 4, text: "nested" }]);
	const packed = packTranscript(clips, "timeline", 15);
	expect(packed).toContain("10-10.5 |3-4 +10 #1 nested");
	expect(packed).toContain("[no words stored]");
	expect(packed).toContain("# No known words 10.5-15");
});

test("packed output is deterministic and bounded in bytes", () => {
	const clips: TranscriptClip[] = Array.from({ length: 120 }, (_, i) => ({
		id: String(i), name: "Spoken clip " + i, media: "Source", start: i * 5, end: i * 5 + 5,
		sourceStart: 0, sourceEnd: 5, known: true,
		phrases: [
			{ start: i * 5 + 0.25, end: i * 5 + 2.12, sourceStart: 0.25, sourceEnd: 2.12, text: "This is a short editing range review." },
			{ start: i * 5 + 2.73, end: i * 5 + 3.48, sourceStart: 2.73, sourceEnd: 3.48, text: "Check the cut." },
		],
	}));
	const view = packTranscript(clips, "timeline", 600);
	expect(packTranscript(clips, "timeline", 600)).toBe(view);
	expect(Buffer.byteLength(view)).toBeLessThan(20_000);
	expect(view).not.toContain("Truncated");
	expect(view).toContain("# No known words 598.48-600");
	for (const clip of clips) clip.phrases[0].text = "文".repeat(250);
	const limited = packTranscript(clips, "timeline", 600);
	expect(Buffer.byteLength(limited)).toBeLessThan(20_000);
	expect(limited).toContain("Truncated");
});

test("the bounded strip uses midpoint frames, mixed peaks, words and quiet rows", () => {
	const input = parseRangeInput({ from: 5, to: 9, rows: 2 });
	expect(rangeRows(input)).toEqual([
		{ from: 5, to: 7, time: 6, y: RANGE_HEADER },
		{ from: 7, to: 9, time: 8, y: RANGE_HEADER + RANGE_ROW_HEIGHT },
	]);
	const peaks = new Float32Array(2 * RANGE_BUCKETS);
	accumulatePeaks(peaks, new Float32Array([0.2, -0.9, 0]), 0, 10);
	expect(Math.max(...peaks)).toBeCloseTo(0.9);
	const labels: string[] = [];
	const boxes: number[][] = [];
	drawRangeView({ font: "", fillStyle: "", fillText: (label) => { labels.push(label); }, fillRect: (...box) => { boxes.push(box); } }, input, {
		title: "Preview", frames: [], peaks, words: [{ start: 5, end: 6, text: "Hello" }],
		spans: [{ start: 5.2, end: 6.2, label: "Track" }, { start: 5, end: 7, label: "Overlay", text: true }],
	});
	expect(labels).toEqual(expect.arrayContaining(["Hello", "Quiet · no known words", "Track", "Overlay"]));
	expect(boxes[0]).toEqual([0, 0, RANGE_WIDTH, RANGE_HEADER + 2 * RANGE_ROW_HEIGHT]);
	expect(boxes.filter(([, , w, h]) => w === 1 && h === 33)).toHaveLength(4);
	for (const invalid of [{ from: -1, to: 2 }, { from: 0, to: 121 }, { from: 1, to: 1.01 }, { from: 0, to: 1, rows: 13 }]) {
		expect(() => parseRangeInput(invalid)).toThrow();
	}
});
