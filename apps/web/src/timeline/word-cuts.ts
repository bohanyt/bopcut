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
function sourceEnd(clip: Clip): number {
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
export function snapCutsToWords(clip: Clip, words: SourceWord[], fps: FrameRate): Pick<Clip, "trimStart" | "duration" | "trimEnd"> | null {
	const { from, to } = playedSpan(clip);
	const start = wordInside(words, from);
	const end = wordInside(words, to);
	if (!start && !end) return null;
	const limit = sourceEnd(clip);
	const newFrom = Math.max(0, start ? start.start : from);
	const target = Math.min(limit, end ? end.end : to);
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
	const trimStart = Math.round(newFrom * TICKS_PER_SECOND) as MediaTime;
	const duration = Math.round(Math.max(frame, seconds) * TICKS_PER_SECOND) as MediaTime;
	const played = Math.round(getSourceTimeAtClipTime({ clipTime: sec(duration), retime: clip.retime }) * TICKS_PER_SECOND);
	const trimEnd = Math.max(0, Math.round(limit * TICKS_PER_SECOND) - trimStart - played) as MediaTime;
	return { trimStart, duration, trimEnd };
}

/**
 * Where word edges of a clip's media fall on the timeline, for snapping one of its edges while it is
 * resized: word starts for the left edge, word ends for the right edge, rounded outwards to whole frames
 * (a frame-rounded edge never lands inside the word). Only words within `window` seconds of the edge.
 */
export function wordEdgeTimes({ clip, startTime, words, side, fps, window = 60 }: {
	clip: Clip; startTime: MediaTime; words: SourceWord[]; side: "left" | "right"; fps: FrameRate; window?: number;
}): MediaTime[] {
	const frameTicks = (TICKS_PER_SECOND * fps.denominator) / fps.numerator;
	const { from, to } = playedSpan(clip);
	const edge = side === "left" ? from : to;
	const times: MediaTime[] = [];
	for (const word of words) {
		const at = side === "left" ? word.start : word.end;
		if (Math.abs(at - edge) > window * Math.max(1, clip.retime?.rate ?? 1)) continue;
		const ticks = startTime + getClipTimeAtSourceTime({ sourceTime: at - from, retime: clip.retime }) * TICKS_PER_SECOND;
		const frames = side === "left" ? Math.floor(ticks / frameTicks + 1e-9) : Math.ceil(ticks / frameTicks - 1e-9);
		times.push(Math.round(frames * frameTicks) as MediaTime);
	}
	return times;
}

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;
