import type { TranscriptClip } from "./packed-transcript";

export type SilenceOptions = {
	/** A pause between words is cut when it is at least this long (seconds). */
	minGap: number;
	/** Kept after the last word before a cut and before the first word after it (seconds). */
	pad: number;
	/** Also cut filler words ("eh", "umm") together with the pauses around them. */
	fillers: boolean;
	/** Cut the silence before the first word. */
	lead: boolean;
	/** Cut the silence after the last word. Off by default: endings often hold music or an end card. */
	tail: boolean;
	/** Media (names or IDs) without words that may be cut through, for example a music bed. */
	ignoreMedia: string[];
};

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = { minGap: 0.4, pad: 0.08, fillers: true, lead: true, tail: false, ignoreMedia: [] };

type Kind = "lead" | "gap" | "filler" | "tail";
type Span = { start: number; end: number };
export type SilenceCut = Span & { seconds: number; kind: Kind; after?: string; before?: string; fillers?: string[] };
export type SkippedSilence = Span & { kind: Kind; clips: string[] };

/** Hesitation sounds only, so real words are never taken for fillers (English and Indonesian). */
const FILLER = /^(?:e+h+|e+h+m+|e+m{2,}|u+h+|u+m+|u+h+m+|h+m+|e+r+m+|a+h+m+)$/;

export function isFiller(text: string) {
	return FILLER.test(text.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""));
}

function subtract(span: Span, blocks: Span[]): Span[] {
	let pieces = [span];
	for (const block of blocks) {
		pieces = pieces.flatMap((piece) => block.end <= piece.start || block.start >= piece.end ? [piece] : [
			...(block.start > piece.start ? [{ start: piece.start, end: block.start }] : []),
			...(block.end < piece.end ? [{ start: block.end, end: piece.end }] : []),
		]);
	}
	return pieces;
}

/**
 * Cuts for dead air and filler words on the root timeline, from the words stored with the media.
 * Every clip that plays sound without stored words blocks cuts over its time, unless its media is
 * ignored, so untranscribed speech is never cut. The ops run from the last cut to the first, so the
 * times of earlier cuts stay valid while later parts of the timeline move up.
 */
export function planSilenceCuts({ clips, duration, fps, options = DEFAULT_SILENCE_OPTIONS }: {
	clips: TranscriptClip[]; duration: number; fps: number; options?: SilenceOptions;
}) {
	const ignored = new Set(options.ignoreMedia);
	const isIgnored = (clip: TranscriptClip) => ignored.has(clip.media) || (!!clip.mediaId && ignored.has(clip.mediaId));
	const unknown = clips.filter((clip) => !clip.known && !isIgnored(clip));
	const words = clips.filter((clip) => clip.known && !isIgnored(clip))
		.flatMap((clip) => clip.phrases.flatMap((phrase) => phrase.words ?? [phrase]))
		.map((word) => ({ start: word.start, end: word.end, text: word.text, filler: options.fillers && isFiller(word.text) }))
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const speech: (Span & { first: string; last: string })[] = [];
	for (const word of words.filter((entry) => !entry.filler)) {
		const previous = speech.at(-1);
		if (previous && word.start <= previous.end) {
			if (word.end > previous.end) Object.assign(previous, { end: word.end, last: word.text });
		} else speech.push({ start: word.start, end: word.end, first: word.text, last: word.text });
	}

	const candidates: (Span & { kind: Kind; after?: string; before?: string })[] = [];
	const fillerWords = (from: number, to: number) => words.filter((word) => word.filler && word.start >= from && word.end <= to);
	const fillersIn = (from: number, to: number) => fillerWords(from, to).map((word) => word.text);
	// The pad keeps air next to real words, but never keeps part of a filler: a filler that sits
	// closer to a word than the pad is cut up to that word's edge.
	const span = (from: number, to: number) => {
		const fillers = fillerWords(from, to);
		const start = Math.min(from + options.pad, fillers[0]?.start ?? Infinity);
		const end = Math.max(to - options.pad, fillers.at(-1)?.end ?? -Infinity);
		return { start: Math.max(from, start), end: Math.min(to, end), filler: fillers.length > 0 };
	};
	if (speech.length) {
		const [first] = speech, last = speech.at(-1)!;
		if (options.lead) {
			const { end } = span(-options.pad, first.start);
			candidates.push({ start: 0, end, kind: "lead", before: first.first });
		}
		speech.slice(1).forEach((next, index) => {
			const previous = speech[index];
			const { start, end, filler } = span(previous.end, next.start);
			if (!filler && next.start - previous.end < options.minGap) return;
			candidates.push({ start, end, kind: filler ? "filler" : "gap", after: previous.last, before: next.first });
		});
		if (options.tail) {
			const { start } = span(last.end, duration + options.pad);
			candidates.push({ start, end: duration, kind: "tail", after: last.last });
		}
	}

	const blocks = unknown.map((clip) => ({ start: clip.start, end: clip.end, name: clip.name }));
	const cuts: SilenceCut[] = [];
	const skipped: SkippedSilence[] = [];
	const frame = (seconds: number) => seconds * fps;
	for (const candidate of candidates) {
		const blockers = blocks.filter((block) => block.start < candidate.end && block.end > candidate.start);
		if (blockers.length && candidate.end > candidate.start) {
			skipped.push({ start: candidate.start, end: candidate.end, kind: candidate.kind, clips: [...new Set(blockers.map((block) => block.name))] });
		}
		for (const piece of subtract(candidate, blockers)) {
			// The cut op keeps whole frames on both sides: the start rounds up and the end down.
			const startFrame = Math.max(0, Math.ceil(frame(piece.start) - 1e-6));
			const endFrame = Math.floor(frame(Math.min(piece.end, duration)) + 1e-6);
			if (endFrame - startFrame < 1) continue;
			const fillers = fillersIn(piece.start - options.pad, piece.end + options.pad);
			cuts.push({ start: startFrame / fps, end: endFrame / fps, seconds: (endFrame - startFrame) / fps, kind: candidate.kind,
				...(candidate.after !== undefined && { after: candidate.after }),
				...(candidate.before !== undefined && { before: candidate.before }),
				...(fillers.length && { fillers }) });
		}
	}
	const removed = cuts.reduce((sum, cut) => sum + cut.seconds, 0);
	return {
		fps, duration, settings: options,
		words: words.length,
		cuts, removed: Math.round(removed * 1000) / 1000,
		...(skipped.length && { skipped }),
		...(unknown.length && { unchecked: unknown.map((clip) => ({ clip: clip.id, name: clip.name, media: clip.media, start: clip.start, end: clip.end })) }),
		ops: [...cuts].sort((a, b) => b.start - a.start).map(({ start, end }) => ({ op: "cut" as const, start, end })),
	};
}
