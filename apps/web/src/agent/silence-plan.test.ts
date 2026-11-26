import { expect, test } from "bun:test";
import type { TranscriptClip } from "./packed-transcript";
import { DEFAULT_SILENCE_OPTIONS, isFiller, planSilenceCuts } from "./silence-plan";

const clip = (id: string, start: number, end: number, words: [string, number, number][] | null, media = id): TranscriptClip => ({
	id, name: id, media, mediaId: `media-${media}`, start, end, sourceStart: start, sourceEnd: end, known: words !== null,
	phrases: (words ?? []).map(([text, from, to]) => ({ text, start: from, end: to, sourceStart: from, sourceEnd: to })),
});
const plan = (clips: TranscriptClip[], options: Partial<typeof DEFAULT_SILENCE_OPTIONS> = {}, duration = 10) =>
	planSilenceCuts({ clips, duration, fps: 30, options: { ...DEFAULT_SILENCE_OPTIONS, ...options } });
const spans = (result: ReturnType<typeof plan>) => result.cuts.map(({ start, end, kind }) => [Math.round(start * 30), Math.round(end * 30), kind]);

test("pauses of at least the minimum gap are cut on whole frames, keeping the pad around the words", () => {
	const result = plan([clip("voice", 0, 10, [["Siapa", 1, 1.5], ["yang", 1.6, 2], ["menang", 3, 3.5], ["ronde", 3.7, 4]])]);
	// Lead 0 → 0.92 s keeps 27 frames; the 1 s pause 2.0 → 3.0 keeps 2.08 → 2.92 as frames 63–87. 0.2 s pauses stay.
	expect(spans(result)).toEqual([[0, 27, "lead"], [63, 87, "gap"]]);
	expect(result.cuts[1]).toMatchObject({ after: "yang", before: "menang" });
	expect(result.ops).toEqual([{ op: "cut", start: 63 / 30, end: 87 / 30 }, { op: "cut", start: 0, end: 27 / 30 }]);
	expect(result.removed).toBe(1.7);
	expect(plan([clip("voice", 0, 10, [["a", 1, 1.5], ["b", 1.6, 2]])], { lead: false, minGap: 0.05, pad: 0 }).cuts).toHaveLength(1);
	expect(plan([clip("voice", 0, 10, [["a", 1, 1.5], ["b", 1.6, 2]])], { lead: false, minGap: 0.05 }).cuts).toHaveLength(0);
});

test("a filler word is cut with the pauses around it, even when they are short; the tail only on request", () => {
	const words: [string, number, number][] = [["jadi", 0, 0.5], ["eh,", 0.6, 0.9], ["gini", 1, 1.4]];
	const result = plan([clip("voice", 0, 10, words)]);
	expect(spans(result)).toEqual([[18, 27, "filler"]]);
	expect(result.cuts[0]).toMatchObject({ after: "jadi", before: "gini", fillers: ["eh,"] });
	expect(spans(plan([clip("voice", 0, 10, words)], { fillers: false }))).toEqual([]);
	expect(spans(plan([clip("voice", 0, 10, words)], { tail: true })).at(-1)).toEqual([45, 300, "tail"]);
});

test("a clip with sound but no stored words blocks cuts over its time unless its media is ignored", () => {
	const voice = clip("voice", 0, 10, [["satu", 1, 1.5], ["dua", 5, 5.5]]);
	const music = clip("music", 2, 3, null);
	const blocked = plan([voice, music], { lead: false });
	// The 3.5 s pause loses the music's 2–3 s span and stays cut on both sides of it.
	expect(spans(blocked)).toEqual([[48, 60, "gap"], [90, 147, "gap"]]);
	expect(blocked.skipped).toEqual([{ start: 1.58, end: 4.92, kind: "gap", clips: ["music"] }]);
	expect(blocked.unchecked).toEqual([{ clip: "music", name: "music", media: "music", start: 2, end: 3 }]);
	expect(spans(plan([voice, music], { lead: false, ignoreMedia: ["music"] }))).toEqual([[48, 147, "gap"]]);
});

test("overlapping speech from two clips counts as one, and a timeline without words gives no cuts", () => {
	const left = clip("left", 0, 10, [["halo", 1, 2]]);
	const right = clip("right", 0, 10, [["iya", 1.8, 3]]);
	expect(spans(plan([left, right], { lead: false }))).toEqual([]);
	expect(plan([], {}).ops).toEqual([]);
});

test("fillers are hesitation sounds, never real words", () => {
	for (const word of ["eh", "Ehm", "umm...", "uh", "Hmm", "erm", "emm", "ahm"]) expect(isFiller(word)).toBe(true);
	for (const word of ["em", "am", "ya", "anu", "uh-huh", "mhm", "her", "eh-eh", "hmm?ya"]) expect(isFiller(word)).toBe(false);
});
