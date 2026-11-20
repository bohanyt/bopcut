/** A spoken word of a media file, in seconds of the source file (from a transcript). */
export type SourceWord = { text: string; start: number; end: number };

/** At most this many words per media file, each at most this long. */
export const MAX_SOURCE_WORDS = 100_000;
export const MAX_WORD_LENGTH = 200;

/**
 * Word timings from outside (an agent, stored metadata), checked: a list of `{text, start, end}` with
 * 0 <= start <= end, sorted by start. Null when the value is not such a list.
 */
export function parseSourceWords(value: unknown): SourceWord[] | null {
	if (!Array.isArray(value) || value.length > MAX_SOURCE_WORDS) return null;
	const words: SourceWord[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return null;
		const { text, start, end } = entry as { text?: unknown; start?: unknown; end?: unknown };
		if (typeof text !== "string" || text.length > MAX_WORD_LENGTH || typeof start !== "number" || typeof end !== "number") return null;
		if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
		words.push({ text, start, end });
	}
	return words.sort((a, b) => a.start - b.start);
}
