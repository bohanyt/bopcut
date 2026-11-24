import { expect, test } from "bun:test";
import { audio, fixture, scene, t, text } from "@/timeline/__tests__/compound-fixtures";
import type { CompoundElement, LibraryAudioElement } from "@/timeline";
import { mapPhrases, packTranscript, sourceTranscript, timelineTranscript, type TranscriptClip } from "./packed-transcript";
import { needsExternalRenderAudio, rangeFontFamilies } from "./range-view-project";
import { accumulatePeaks, drawRangeView, parseRangeInput, RANGE_BUCKETS, RANGE_HEADER, RANGE_ROW_HEIGHT, RANGE_WIDTH, rangeRows } from "./range-view";

test("phrases split at half a second and retain both axes through a cut and retime", () => {
	const results = mapPhrases([
		{ text: "cut out", start: 0, end: 1 },
		{ text: "edge", start: 1.5, end: 2.5 },
		{ text: "word", start: 3, end: 3.5 },
		{ text: "later", start: 4.5, end: 6 },
		{ text: "outside", start: 6, end: 7 },
	], 10, 12, 2, 2);
	expect(results).toMatchObject([
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
	root.tracks.audio[0].elements.push({ ...audio("muted-clip", 10, 2), params: { muted: true } });
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
		id: String(i), name: "Spoken clip " + i, media: "Source", mediaId: "source", start: i * 5, end: i * 5 + 5,
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

test("uninterrupted speech is paged at word boundaries and the cap identifies what was omitted", () => {
	const words = Array.from({ length: 200 }, (_, index) => ({
		start: index / 10, end: (index + 1) / 10, text: `word${index} ${"文".repeat(190)}`,
	}));
	const clip = sourceTranscript({ id: "voice", name: "Voice", duration: 20, words });
	expect(clip.phrases[0].end).toBe(2.5);
	expect(clip.phrases[1].start).toBe(2.5);
	const paced = mapPhrases(Array.from({ length: 20 }, (_, index) => ({ start: index, end: index + 0.8, text: "word" })), 0, 20, 0);
	expect(paced.map(({ start }) => start)).toEqual([0, 12]);
	const output = packTranscript([clip], "source", 20);
	expect(output).toContain("word0 ");
	expect(output).toContain("word24 ");
	expect(output).toContain("word25 ");
	expect(output).toContain("2.5-3.3 +0 #1 word25 ");
	expect(output).not.toContain("word33 ");
	expect(output).toContain("Entries omitted from 3.3s through 20s.");
	expect(Buffer.byteLength(output)).toBeLessThan(20_000);
});

test("shared media labels use IDs to distinguish identical names", () => {
	const [root] = fixture();
	root.tracks.main.muted = true;
	root.tracks.audio[0].elements = [audio("first", 0, 1), { ...audio("first", 1, 1), id: "repeat" }, audio("second", 2, 1)];
	const clips = timelineTranscript(root, [root], ["media-first", "media-second"].map((id) => ({ id, name: "Recording" })));
	const output = packTranscript(clips, "timeline", 3);
	expect(output.match(/@1 Recording \[media-first\]/g)).toHaveLength(1);
	expect(output).toContain("second (Recording [media-second])");
	expect(output).not.toContain("second @1");
});

test("preflight considers only unmuted external audio that overlaps the requested window", () => {
	const [root] = fixture();
	const remote: LibraryAudioElement = { ...audio("remote", 5, 2), sourceType: "library", sourceUrl: "https://example.com/a.wav" };
	root.tracks.audio[0].elements = [remote];
	expect(needsExternalRenderAudio(root, [root], [], { from: 1, to: 5, rows: 1 })).toBe(false);
	expect(needsExternalRenderAudio(root, [root], [], { from: 7, to: 10, rows: 1 })).toBe(false);
	expect(needsExternalRenderAudio(root, [root], [], { from: 6, to: 8, rows: 1 })).toBe(true);
	remote.params.muted = true;
	expect(needsExternalRenderAudio(root, [root], [], { from: 6, to: 8, rows: 1 })).toBe(false);
});

test("fonts are limited to visible elements inside the root range and trimmed compounds", () => {
	const [root] = fixture();
	const named = (fontFamily: string, start: number) => ({
		...text(fontFamily, start, 1), params: { fontFamily },
	});
	root.tracks.overlay = [{ id: "titles", name: "Titles", type: "text", hidden: false, elements: [
		named("Used", 0), named("Too late", 2), { ...named("Hidden", 0), hidden: true },
	] }];
	root.tracks.main.elements = [{ ...root.tracks.main.elements[0], type: "compound", sceneId: "nested",
		startTime: t(0), duration: t(2), trimStart: t(3) }];
	const nested = scene("nested", { ...root.tracks, main: { ...root.tracks.main, elements: [] },
		overlay: [{ ...root.tracks.overlay[0], type: "text", elements: [named("Trimmed out", 2), named("Nested", 3)] }] },
		{ kind: "compound" });
	expect(rangeFontFamilies(root, [root, nested], { from: 0, to: 2, rows: 2 })).toEqual(["Used", "Nested"]);
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
	drawRangeView({ font: "", fillStyle: "", measureText: () => ({ width: 30 }),
		fillText: (label) => { labels.push(label); }, fillRect: (...box) => { boxes.push(box); } }, input, {
		title: "Preview", frames: [], peaks, words: [{ start: 5, end: 6, text: "Hello" }],
		spans: [{ start: 5.2, end: 6.2, label: "Track" }, { start: 5, end: 7, label: "Overlay", text: true }],
	});
	expect(labels).toEqual(expect.arrayContaining(["Hello", "Quiet · no known words", "Track", "Overlay"]));
	expect(boxes[0]).toEqual([0, 0, RANGE_WIDTH, RANGE_HEADER + 2 * RANGE_ROW_HEIGHT]);
	expect(boxes.filter(([, , w, h]) => w === 1 && h === 46)).toHaveLength(4);
	for (const invalid of [{ from: -1, to: 2 }, { from: 0, to: 121 }, { from: 1, to: 1.01 }, { from: 0, to: 1, rows: 13 }]) {
		expect(() => parseRangeInput(invalid)).toThrow();
	}
});

test("word labels stay on their time anchors in two measured lanes with dots for overflow and cut marks", () => {
	const ctx = {
		font: "", fillStyle: "", labels: [] as Array<[string, number, number]>, boxes: [] as Array<[string, number, number, number, number]>,
		measureText: () => ({ width: 200 }),
		fillText(label: string, x: number, y: number) { this.labels.push([label, x, y]); },
		fillRect(x: number, y: number, w: number, h: number) { this.boxes.push([this.fillStyle, x, y, w, h]); },
	};
	const words = mapPhrases([
		{ start: 0, end: 1.08, text: "Partial" }, { start: 1.1, end: 1.15, text: "Second" },
		{ start: 1.2, end: 1.3, text: "Crowded" }, { start: 4.9, end: 5.1, text: "Cut off" },
	], 1, 5, 1, 1, false);
	drawRangeView(ctx, { from: 1, to: 5, rows: 1 }, {
		title: "Words", words, frames: [], spans: [], peaks: new Float32Array(RANGE_BUCKETS),
	});
	const first = ctx.labels.find(([label]) => label === "Partial")!;
	const second = ctx.labels.find(([label]) => label === "Second")!;
	expect(first.slice(1)).toEqual([232, RANGE_HEADER + 85]);
	expect(second[1]).toBeCloseTo(249.75);
	expect(second[2]).toBe(first[2] + 16);
	expect(ctx.labels.filter(([label]) => label === "•")).toHaveLength(2);
	expect(ctx.labels.some(([label]) => label === "Crowded" || label === "Cut off")).toBe(false);
	expect(ctx.boxes.filter(([color]) => color === "#f0ab70")).toHaveLength(2);
});
