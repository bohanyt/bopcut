import type { TextElement } from "@/timeline";
import { mediaTime, TICKS_PER_SECOND } from "@/wasm";

export interface CaptionWord {
	text: string;
	/** Seconds in the untrimmed element. Intervals are half-open. */
	start: number;
	end: number;
	highlight?: boolean;
	approximate?: boolean;
}

export interface CaptionData {
	words: CaptionWord[];
	approximate: boolean;
}

export const captionTokens = (text: string): string[] =>
	text.match(/\S+/gu) ?? [];
const matchKey = (text: string) =>
	text
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[\p{P}\p{S}]/gu, "");

export function distributeWordTimings(
	text: string,
	duration: number,
	start = 0,
): CaptionData {
	const tokens = captionTokens(text);
	const step = Math.max(0, duration) / Math.max(1, tokens.length);
	return {
		approximate: true,
		words: tokens.map((text, i) => ({
			text,
			start: start + i * step,
			end: start + (i + 1) * step,
			approximate: true,
		})),
	};
}

export function makeCaption(
	text: string,
	duration: number,
	words?: CaptionWord[],
): CaptionData {
	if (!Number.isFinite(duration) || duration <= 0)
		throw new Error("Caption duration must be positive");
	if (!words) return distributeWordTimings(text, duration);
	const tokens = captionTokens(text);
	if (
		tokens.length !== words.length ||
		words.some(
			(word, i) =>
				word.text !== tokens[i] ||
				!Number.isFinite(word.start) ||
				!Number.isFinite(word.end) ||
				word.start < 0 ||
				word.end <= word.start ||
				word.end > duration + 1e-6 ||
				(i > 0 && word.start < words[i - 1].end),
		)
	) {
		throw new Error(
			"Caption words must match the text and have ordered, non-overlapping timings within the duration",
		);
	}
	return {
		words: words.map((word) => ({ ...word })),
		approximate: words.some((word) => word.approximate === true),
	};
}

export function activeWordIndex(
	words: readonly CaptionWord[],
	time: number,
): number {
	return words.findIndex((word) => time >= word.start && time < word.end);
}

/** Pair repeated words in order when the same words are rearranged. */
function keepReorderedHighlights(edited: CaptionData, original: readonly CaptionWord[]): CaptionData {
	if (edited.words.length !== original.length || original.every(word => word.highlight === undefined)) return edited;

	const identity = (text: string) => matchKey(text) || text;
	const originalByText = new Map<string, CaptionWord[]>();
	for (let i = original.length - 1; i >= 0; i--) {
		const word = original[i];
		const key = identity(word.text);
		const matches = originalByText.get(key) ?? [];
		matches.push(word);
		originalByText.set(key, matches);
	}
	const matches = edited.words.map(word => originalByText.get(identity(word.text))?.pop());
	if (!matches.every(word => word !== undefined)) return edited;
	for (const [index, word] of edited.words.entries()) {
		const highlight = matches[index].highlight;
		if (highlight === undefined) delete word.highlight;
		else word.highlight = highlight;
	}
	return edited;
}

/** Keep matching words in order; evenly distribute changed runs between retained anchors. */
export function editCaptionText(
	caption: CaptionData,
	text: string,
	duration: number,
	start = 0,
): CaptionData {
	const tokens = captionTokens(text);
	const old = caption.words;
	const table = Array.from(
		{ length: old.length + 1 },
		() => new Uint32Array(tokens.length + 1),
	);
	for (let i = old.length - 1; i >= 0; i--) {
		for (let j = tokens.length - 1; j >= 0; j--) {
			table[i][j] =
				matchKey(old[i].text) === matchKey(tokens[j])
					? 1 + table[i + 1][j + 1]
					: Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const words: (CaptionWord | undefined)[] = tokens.map(() => undefined);
	let i = 0;
	let j = 0;
	while (i < old.length && j < tokens.length) {
		if (matchKey(old[i].text) === matchKey(tokens[j])) {
			words[j] = { ...old[i], text: tokens[j] };
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) i++;
		else j++;
	}
	for (let from = 0; from < words.length; ) {
		if (words[from]) {
			from++;
			continue;
		}
		let to = from;
		while (to < words.length && !words[to]) to++;
		const left = words[from - 1]?.end ?? start;
		const right = words[to]?.start ?? start + duration;
		// Insertions between contiguous timings have no room: redistribute the phrase.
		if (right <= left) {
			const distributed = distributeWordTimings(text, duration, start);
			distributed.words.forEach((word, index) => {
				if (words[index]?.highlight) word.highlight = true;
			});
			return keepReorderedHighlights(distributed, old);
		}
		for (let k = from; k < to; k++) {
			words[k] = {
				text: tokens[k],
				start: left + ((right - left) * (k - from)) / (to - from),
				end: left + ((right - left) * (k - from + 1)) / (to - from),
				approximate: true,
			};
		}
		from = to;
	}
	const result = words.filter(
		(word): word is CaptionWord => word !== undefined,
	);
	return keepReorderedHighlights({
		words: result,
		approximate: result.some((word) => word.approximate === true),
	}, old);
}

export function reconcileCaptionEdit(
	previous: TextElement,
	next: TextElement,
): TextElement {
	if (!previous.caption || next.caption !== previous.caption) return next;
	const visibleEnd = next.trimStart + next.duration;
	// Old duration-only edits can leave saved words beyond the recorded trim.
	const wordEnd = previous.caption.words.at(-1)?.end ?? 0;
	const extent = Math.max(
		visibleEnd,
		previous.trimStart + previous.duration + previous.trimEnd,
		Math.ceil(wordEnd * TICKS_PER_SECOND - 1e-6),
	);
	const trimEnd = mediaTime({ ticks: extent - visibleEnd });
	if (previous.params.content === next.params.content) {
		return trimEnd === next.trimEnd ? next : { ...next, trimEnd };
	}
	return {
		...next,
		trimEnd,
		caption: editCaptionText(
			previous.caption,
			String(next.params.content ?? ""),
			extent / TICKS_PER_SECOND,
		),
	};
}

/** Wrap words without breaking explicit paragraphs. The width limit wins if a pair cannot fit. */
export function wrapCaptionWords(
	text: string,
	maxWidth: number,
	noOrphan: boolean,
	measure: (text: string) => number,
	extraSpace = 0,
): number[][] {
	let offset = 0;
	const output: number[][] = [];
	for (const paragraph of text.split(/\r?\n/u)) {
		const tokens = captionTokens(paragraph);
		const widths = tokens.map(measure);
		const gap = measure(" ") + extraSpace;
		const width = (line: number[]) =>
			line.reduce((sum, index) => sum + widths[index - offset], 0) +
			Math.max(0, line.length - 1) * gap;
		const lines: number[][] = [[]];
		for (let i = 0; i < tokens.length; i++) {
			let line = lines[lines.length - 1];
			if (
				line.length &&
				maxWidth > 0 &&
				width([...line, offset + i]) > maxWidth
			) {
				line = [];
				lines.push(line);
			}
			line.push(offset + i);
		}
		const last = lines[lines.length - 1];
		const before = lines[lines.length - 2];
		if (noOrphan && last.length === 1 && before && before.length > 1) {
			const pair = [before[before.length - 1], ...last];
			if (maxWidth <= 0 || width(pair) <= maxWidth) {
				before.pop();
				last.unshift(pair[0]);
			}
		}
		output.push(...lines);
		offset += tokens.length;
	}
	return output;
}
