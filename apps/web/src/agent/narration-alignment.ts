import type { SourceWord } from "@/media/words";

export const MAX_NARRATION_WORDS = 5000;
const WINDOW = 96;
const CELL_BUDGET = 400_000;
const spokenNumbers = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
const fillers = new Set(["um", "uh", "erm", "hmm"]);

export function narrationToken(text: string): string {
	const token = text.normalize("NFKC").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
	const number = spokenNumbers.indexOf(token);
	return number >= 0 ? String(number) : token;
}

export type WordMatch = { old: number; next: number; confidence: "high" | "review"; reason: string };

function uniquePhrases(words: string[]) {
	const phrases = new Map<string, number>();
	for (let i = 0; i + 2 < words.length; i++) {
		const phrase = words.slice(i, i + 3);
		if (phrase.some((word) => !word || fillers.has(word))) continue;
		const key = JSON.stringify(phrase);
		phrases.set(key, phrases.has(key) ? -1 : i);
	}
	return phrases;
}

function landmarks(old: string[], next: string[]) {
	const positions = uniquePhrases(next);
	const pairs = [...uniquePhrases(old)].flatMap(([key, i]) => {
		const j = positions.get(key) ?? -1;
		return i < 0 || j < 0 ? [] : [{ old: i, next: j }];
	});
	const suffix = new Int32Array(pairs.length + 1).fill(next.length);
	for (let i = pairs.length - 1; i >= 0; i--) suffix[i] = Math.min(suffix[i + 1], pairs[i].next);
	let highest = -1, last = -3, lastNext = -3;
	return pairs.filter((pair, i) => {
		const ordered = pair.next > highest && pair.next < suffix[i + 1];
		highest = Math.max(highest, pair.next);
		if (!ordered || pair.old < last + 3 || pair.next < lastNext + 3) return false;
		last = pair.old;
		lastNext = pair.next;
		return true;
	});
}

function similar(a: string, b: string) {
	// One inserted, omitted or substituted character. Short words are too ambiguous.
	if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
	if (a.length > b.length) [a, b] = [b, a];
	let i = 0;
	while (i < a.length && a[i] === b[i]) i++;
	return a.slice(i + Number(a.length === b.length)) === b.slice(i + 1);
}

function alignWindow(old: string[], next: string[], left: number, right: number, context: boolean, check: () => void): WordMatch[] {
	const m = old.length, n = next.length, width = n + 1;
	const before = new Uint16Array((m + 1) * width), after = new Uint16Array(before.length);
	const costs = new Uint8Array(m * n);
	const gap = (word: string) => fillers.has(word) ? 1 : 3;
	for (let i = 0; i <= m; i++) {
		check();
		for (let j = 0; j <= n; j++) {
			const at = i * width + j;
			const a = old[i - 1], b = next[j - 1];
			const cost = i && j ? (a && a === b && !fillers.has(a) ? 0 : context && similar(a, b) ? 4 : 7) : 7;
			if (i && j) costs[(i - 1) * n + j - 1] = cost;
			if (at) before[at] = Math.min(i ? before[at - width] + gap(a) : Infinity,
				j ? before[at - 1] + gap(b) : Infinity, i && j ? before[at - width - 1] + cost : Infinity);
		}
	}
	for (let i = m; i >= 0; i--) {
		for (let j = n; j >= 0; j--) {
			const at = i * width + j;
			if (i === m && j === n) continue;
			after[at] = Math.min(i < m ? after[at + width] + gap(old[i]) : Infinity,
				j < n ? after[at + 1] + gap(next[j]) : Infinity,
				i < m && j < n ? after[at + width + 1] + costs[i * n + j] : Infinity);
		}
	}
	const best = before.at(-1)!;
	const matches: WordMatch[] = [];
	for (let i = 0; i < m; i++) {
		let match = -1;
		let ambiguous = false;
		for (let j = 0; j <= n; j++) {
			const at = i * width + j;
			if (before[at] + gap(old[i]) + after[at + width] === best) ambiguous = true;
			const cost = costs[i * n + j];
			if (j < n && cost < 7 && before[at] + cost + after[at + width + 1] === best) {
				ambiguous ||= match !== -1;
				match = j;
			}
		}
		if (match === -1 || ambiguous) continue;
		const exact = costs[i * n + match] === 0;
		matches.push({ old: left + i, next: right + match, confidence: exact ? "high" : "review",
			reason: exact ? "unique optimal word match" : "one-character difference between phrase anchors" });
	}
	return matches;
}

export function alignNarration(old: SourceWord[], next: SourceWord[], check: () => void = () => {}) {
	if (!old.length || !next.length || Math.max(old.length, next.length) > MAX_NARRATION_WORDS) {
		throw new Error("Each transcript needs 1 to 5,000 words.");
	}
	for (const transcript of [old, next]) {
		if (transcript.some((word, i) => !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
			word.start < 0 || word.end <= word.start || (i > 0 && transcript[i - 1].end > word.start))) {
			throw new Error("Narration words must have positive, ordered, non-overlapping intervals.");
		}
	}
	check();
	const a = old.map((word) => narrationToken(word.text)), b = next.map((word) => narrationToken(word.text));
	const matches: WordMatch[] = [];
	let i = 0, j = 0, budget = CELL_BUDGET;
	let limited = false;
	for (const pair of [...landmarks(a, b), { old: a.length, next: b.length }]) {
		check();
		const m = pair.old - i, n = pair.next - j;
		if (m && n) {
			if (m <= WINDOW && n <= WINDOW && m * n <= budget) {
				budget -= m * n;
				matches.push(...alignWindow(a.slice(i, pair.old), b.slice(j, pair.next), i, j, i > 0 && pair.old < a.length, check));
			} else limited = true;
		}
		if (pair.old === a.length) break;
		for (let k = 0; k < 3; k++) matches.push({ old: pair.old + k, next: pair.next + k, confidence: "high", reason: "unique ordered phrase" });
		i = pair.old + 3;
		j = pair.next + 3;
	}
	return { matches, limited };
}
