// Cuts that never chop a word: where a clip's cut points fall inside a spoken word of its media (from
// the media's word timings), and how to move them out of it.
import type { FrameRate } from "opencut-wasm";
import type { SourceWord } from "@/media/words";
import type { RetimeConfig } from "@/timeline";
import { getClipTimeAtSourceTime, getSourceTimeAtClipTime } from "@/retime/resolve";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

/** A cut inside a word by less than this (seconds) does not count: word timings are not that exact. */
export const WORD_TOLERANCE = 0.02;
/** Words that start this many entries earlier are still checked for overlap. */
const OVERLAP_LOOKBACK = 8;

type Clip = { trimStart: MediaTime; duration: MediaTime; trimEnd: MediaTime; sourceDuration?: MediaTime; retime?: RetimeConfig };
const sec = (ticks: number) => ticks / TICKS_PER_SECOND;

/**
 * The part of the source a clip plays, in source seconds. Trims are in source time; the duration is in
 * timeline time, so a retimed clip plays `duration × rate` of its source.
 */
export function playedSpan(clip: Clip): { from: number; to: number } {
	const from = sec(clip.trimStart);
	return { from, to: from + getSourceTimeAtClipTime({ clipTime: sec(clip.duration), retime: clip.retime }) };
}

/** Where the clip's source ends, in source seconds (its source duration, else what its trims leave). */
export function sourceEnd(clip: Clip): number {
	return clip.sourceDuration !== undefined ? sec(clip.sourceDuration) : playedSpan(clip).to + sec(clip.trimEnd);
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
	// Words are sorted by start; a longer word that starts a little earlier can still span the time.
	for (let i = found; i >= 0 && i > found - OVERLAP_LOOKBACK; i--) {
		const word = words[i];
		if (time > word.start + tolerance && time < word.end - tolerance) return word;
	}
	return null;
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
 * one goes on to its end, so the whole word plays. The duration is then made a whole number of frames:
 * rounded up, unless that would reach into the next word or past the end of the source, then down if
 * the word still plays to within the tolerance, else left exact. The start stays where it is on the
 * timeline. Null when no cut is inside a word.
 */
export function snapCutsToWords(clip: Clip, words: SourceWord[], fps: FrameRate, { limit = sourceEnd(clip) }: { limit?: number } = {}): Pick<Clip, "trimStart" | "duration" | "trimEnd"> | null {
	const { from, to } = playedSpan(clip);
	if (!wordInside(words, from) && !wordInside(words, to)) return null;
	// Overlapping words: moving out of one can land inside another, so the cut moves until it is out of all.
	let newFrom = from;
	for (let i = 0, word = wordInside(words, newFrom); word && i < OVERLAP_LOOKBACK * 2; i++, word = wordInside(words, newFrom)) newFrom = word.start;
	newFrom = Math.max(0, newFrom);
	let target = to;
	for (let i = 0, word = wordInside(words, target); word && i < OVERLAP_LOOKBACK * 2; i++, word = wordInside(words, target)) target = word.end;
	target = Math.min(limit, target);
	const frame = fps.denominator / fps.numerator;
	// Timeline length of the source span, then whole frames of it.
	const exact = getClipTimeAtSourceTime({ sourceTime: target - newFrom, retime: clip.retime });
	const sourceAt = (clipSeconds: number) => newFrom + getSourceTimeAtClipTime({ clipTime: clipSeconds, retime: clip.retime });
	const up = Math.ceil(exact / frame - 1e-9) * frame;
	const down = Math.max(frame, Math.floor(exact / frame + 1e-9) * frame);
	const upEnd = sourceAt(up);
	const fitsUp = upEnd <= limit + 1e-9 && !wordInside(words, upEnd);
	const keepsWord = sourceAt(down) >= target - WORD_TOLERANCE;
	const seconds = fitsUp ? up : keepsWord ? down : exact;
	// At least one frame, unless even that runs past the end of the source.
	const atLeastFrame = sourceAt(frame) <= limit + 1e-9 ? Math.max(frame, seconds) : seconds;
	const trimStart = Math.round(newFrom * TICKS_PER_SECOND) as MediaTime;
	const duration = Math.round(atLeastFrame * TICKS_PER_SECOND) as MediaTime;
	const played = Math.round(getSourceTimeAtClipTime({ clipTime: sec(duration), retime: clip.retime }) * TICKS_PER_SECOND);
	const trimEnd = Math.max(0, Math.round(limit * TICKS_PER_SECOND) - trimStart - played) as MediaTime;
	return { trimStart, duration, trimEnd };
}

/**
 * Where word edges of a clip's media fall on the timeline, for snapping one of its edges while it is
 * resized: word starts for the left edge, word ends for the right edge. A resize moves an edge by whole
 * frames from where it is, so each mark is that edge plus whole frames, rounded outwards from the word
 * (the cut never lands inside it), and a mark that would land inside another word is left out. Only
 * words within `window` seconds of the edge.
 */
export function wordEdgeTimes({ clip, startTime, words, side, fps, window = 60 }: {
	clip: Clip; startTime: MediaTime; words: SourceWord[]; side: "left" | "right"; fps: FrameRate; window?: number;
}): MediaTime[] {
	const frameTicks = (TICKS_PER_SECOND * fps.denominator) / fps.numerator;
	const { from, to } = playedSpan(clip);
	const edgeTicks = side === "left" ? startTime : startTime + clip.duration;
	const sourceAtTicks = (ticks: number) => from + getSourceTimeAtClipTime({ clipTime: (ticks - startTime) / TICKS_PER_SECOND, retime: clip.retime });
	const edgeSource = side === "left" ? from : to;
	const times: MediaTime[] = [];
	for (const word of words) {
		const at = side === "left" ? word.start : word.end;
		if (Math.abs(at - edgeSource) > window * Math.max(1, clip.retime?.rate ?? 1)) continue;
		const ticks = startTime + getClipTimeAtSourceTime({ sourceTime: at - from, retime: clip.retime }) * TICKS_PER_SECOND;
		const steps = (ticks - edgeTicks) / frameTicks;
		const frames = side === "left" ? Math.floor(steps + 1e-9) : Math.ceil(steps - 1e-9);
		const mark = Math.round(edgeTicks + frames * frameTicks);
		if (wordInside(words, sourceAtTicks(mark))) continue;
		times.push(mark as MediaTime);
	}
	return times;
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
