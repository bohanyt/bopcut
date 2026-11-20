// Cuts that never chop a word: where a clip's cut points fall inside a spoken word of its media (from
// the media's word timings), and how to move them out of it.
import type { FrameRate } from "opencut-wasm";
import type { SourceWord } from "@/media/words";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

/** A cut inside a word by less than this (seconds) does not count: word timings are not that exact. */
export const WORD_TOLERANCE = 0.02;

type Clip = { trimStart: MediaTime; duration: MediaTime; trimEnd: MediaTime; sourceDuration?: MediaTime };
const sec = (ticks: number) => ticks / TICKS_PER_SECOND;

/** The part of the source a clip plays, in source seconds. */
export function playedSpan(clip: Clip): { from: number; to: number } {
	const from = sec(clip.trimStart);
	return { from, to: from + sec(clip.duration) };
}

/** The word a source time falls inside (away from its edges by more than `tolerance`), or null. */
export function wordInside(words: SourceWord[], time: number, tolerance = WORD_TOLERANCE): SourceWord | null {
	let lo = 0;
	let hi = words.length - 1;
	let found = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (words[mid].start <= time) {
			found = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	if (found < 0) return null;
	const word = words[found];
	return time > word.start + tolerance && time < word.end - tolerance ? word : null;
}

/** A cut point of a clip that falls inside a word: which edge, where (source seconds), and the word. */
export type CutWarning = { edge: "start" | "end"; at: number; word: SourceWord };

export function cutWarnings(clip: Clip, words: SourceWord[]): CutWarning[] {
	const { from, to } = playedSpan(clip);
	const warnings: CutWarning[] = [];
	const start = wordInside(words, from);
	if (start) warnings.push({ edge: "start", at: round(from), word: start });
	const end = wordInside(words, to);
	if (end) warnings.push({ edge: "end", at: round(to), word: end });
	return warnings;
}

/**
 * Moves a clip's cuts out of words: a start inside a word goes back to the word's start, an end inside
 * one goes on to its end, so the whole word plays. The duration is then rounded up to whole frames (the
 * start stays where it is on the timeline). Null when no cut is inside a word.
 */
export function snapCutsToWords(clip: Clip, words: SourceWord[], fps: FrameRate): Pick<Clip, "trimStart" | "duration" | "trimEnd"> | null {
	const { from, to } = playedSpan(clip);
	const start = wordInside(words, from);
	const end = wordInside(words, to);
	if (!start && !end) return null;
	const limit = clip.sourceDuration !== undefined ? sec(clip.sourceDuration) : Number.POSITIVE_INFINITY;
	const newFrom = Math.max(0, start ? start.start : from);
	const newTo = Math.min(limit, end ? end.end : to);
	const frame = fps.denominator / fps.numerator;
	const frames = Math.max(1, Math.ceil((newTo - newFrom) / frame - 1e-9));
	const trimStart = Math.round(newFrom * TICKS_PER_SECOND) as MediaTime;
	const duration = Math.round(frames * frame * TICKS_PER_SECOND) as MediaTime;
	const trimEnd = (clip.sourceDuration !== undefined
		? Math.max(0, clip.sourceDuration - trimStart - duration)
		: Math.max(0, clip.trimEnd - (trimStart + duration - clip.trimStart - clip.duration))) as MediaTime;
	return { trimStart, duration, trimEnd };
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
