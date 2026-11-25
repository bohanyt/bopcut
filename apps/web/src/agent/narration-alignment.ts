import type { SourceWord } from "@/media/words";

export const MAX_NARRATION_WORDS = 5000;
const WINDOW = 96;
const CELL_BUDGET = 400_000;
const spokenNumbers = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
const indonesianNumbers = "nol|satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|sebelas|dua belas|tiga belas|empat belas|lima belas|enam belas|tujuh belas|delapan belas|sembilan belas|dua puluh".split("|");
const fillers = new Set(["um", "uh", "erm", "hmm"]);

const key = (text: string) => text.normalize("NFKC").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

export function narrationToken(text: string): string {
	const token = key(text).replace(/\s+/g, " ");
	const english = spokenNumbers.indexOf(token);
	const number = english < 0 ? indonesianNumbers.indexOf(token) : english;
	return number >= 0 ? String(number) : token;
}

/** A two-word number has one alignment index and keeps both source words' timing. */
export function narrationWords(words: SourceWord[]): SourceWord[] {
	const result: SourceWord[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i], next = words[i + 1];
		if (next && next.start >= word.end && next.start - word.end <= 0.5 &&
			word.end > word.start && next.end > next.start &&
			indonesianNumbers.indexOf(`${key(word.text)} ${key(next.text)}`) >= 12) {
			result.push({ text: `${word.text} ${next.text}`, start: word.start, end: next.end });
			i++;
		} else result.push(word);
	}
	return result;
}

export type WordMatch = { old: number; next: number; confidence: "high" | "review"; reason: string };

function uniquePhrases(words: string[]) {
	const phrases = new Map<string, number>();
	const seen = new Set<string>(), repeated = new Set<string>();
	const bigram = (i: number) => JSON.stringify([words[i], words[i + 1]]);
	for (let i = 0; i + 1 < words.length; i++) {
		const pair = bigram(i);
		if (seen.has(pair)) repeated.add(pair);
		seen.add(pair);
	}
	for (let i = 0; i + 2 < words.length; i++) {
		const phrase = words.slice(i, i + 3);
		// One extra word does not make an otherwise repeated phrase a reliable landmark.
		if (repeated.has(bigram(i)) || repeated.has(bigram(i + 1))) continue;
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
	const ranks = (reverse: boolean) => {
		const lengths = new Int32Array(pairs.length);
		const tails: number[] = [];
		for (let n = 0; n < pairs.length; n++) {
			const i = reverse ? pairs.length - 1 - n : n;
			const value = (reverse ? -1 : 1) * pairs[i].next;
			let lo = 0, hi = tails.length;
			while (lo < hi) {
				const mid = (lo + hi) >>> 1;
				if (tails[mid] < value) lo = mid + 1;
				else hi = mid;
			}
			tails[lo] = value;
			lengths[i] = lo + 1;
		}
		return { lengths, longest: tails.length };
	};
	const { lengths: prefix, longest } = ranks(false);
	const { lengths: suffix } = ranks(true);
	const choices = new Int32Array(longest + 1);
	for (let i = 0; i < pairs.length; i++) {
		if (prefix[i] + suffix[i] - 1 === longest) choices[prefix[i]]++;
	}
	// Keep the landmarks present in every longest sequence. Tied reorderings need review.
	let last = -3, lastNext = -3;
	return pairs.filter((pair, i) => {
		if (prefix[i] + suffix[i] - 1 !== longest || choices[prefix[i]] !== 1) return false;
		if (pair.old < last + 3 || pair.next < lastNext + 3) return false;
		({ old: last, next: lastNext } = pair);
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

function alignWindow(old: string[], next: string[], left: number, right: number, anchoredRight: boolean, check: () => void): WordMatch[] {
	const m = old.length, n = next.length, width = n + 1;
	const before = new Uint16Array((m + 1) * width), after = new Uint16Array(before.length);
	const costs = new Uint8Array(m * n);
	const gap = (word: string) => fillers.has(word) ? 1 : 3;
	for (let i = 0; i <= m; i++) {
		check();
		for (let j = 0; j <= n; j++) {
			const at = i * width + j;
			const a = old[i - 1], b = next[j - 1];
			const cost = i && j ? (a && a === b && !fillers.has(a) ? 0 : left > 0 && anchoredRight && similar(a, b) ? 4 : 7) : 7;
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
	const candidates = [];
	for (let i = 0; i < m; i++) {
		let match = -1;
		let alternative = Infinity;
		for (let j = 0; j <= n; j++) {
			const at = i * width + j;
			alternative = Math.min(alternative, before[at] + gap(old[i]) + after[at + width]);
			const cost = costs[i * n + j];
			if (j >= n || cost >= 7) continue;
			const total = before[at] + cost + after[at + width + 1];
			if (total === best && match === -1) match = j;
			else alternative = Math.min(alternative, total);
		}
		if (match === -1 || alternative === best) continue;
		candidates.push({ i, j: match, exact: costs[i * n + match] === 0, margin: alternative - best });
	}
	const repeated = (words: string[], token: string) => words.indexOf(token) !== words.lastIndexOf(token);
	return candidates.map(({ i, j, exact, margin }, index) => {
		const adjacent = (other: typeof candidates[number] | undefined, step: number) => {
			if (!other?.exact || repeated(old, old[other.i]) || repeated(next, next[other.j])) return false;
			const a = (other.i - i) * step, b = (other.j - j) * step;
			return Math.min(a, b) === 1 && Math.max(a, b) <= 2;
		};
		const landmark = (left > 0 && i === 0 && j === 0) || (anchoredRight && i === m - 1 && j === n - 1);
		const neighbours = adjacent(candidates[index - 1], -1) || adjacent(candidates[index + 1], 1);
		const repeat = repeated(old, old[i]) || repeated(next, next[j]);
		const high = exact && margin >= 2 && (landmark || (neighbours && !repeat));
		return { old: left + i, next: right + j, confidence: high ? "high" : "review",
			reason: high ? "supported exact match with a clear alternative gap" : !exact ? "one-character difference between phrase anchors"
				: margin < 2 ? "another alignment is nearly as good" : repeat ? "word repeats without an adjacent phrase anchor" : "isolated word match" };
	});
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
	const a = narrationWords(old).map((word) => narrationToken(word.text)), b = narrationWords(next).map((word) => narrationToken(word.text));
	const matches: WordMatch[] = [];
	let i = 0, j = 0, budget = CELL_BUDGET;
	let limited = false;
	for (const pair of [...landmarks(a, b), { old: a.length, next: b.length }]) {
		check();
		const m = pair.old - i, n = pair.next - j;
		if (m && n) {
			if (m <= WINDOW && n <= WINDOW && m * n <= budget) {
				budget -= m * n;
				matches.push(...alignWindow(a.slice(i, pair.old), b.slice(j, pair.next), i, j, pair.old < a.length, check));
			} else limited = true;
		}
		if (pair.old === a.length) break;
		for (let k = 0; k < 3; k++) matches.push({ old: pair.old + k, next: pair.next + k, confidence: "high", reason: "unique ordered phrase" });
		i = pair.old + 3;
		j = pair.next + 3;
	}
	return { matches, limited };
}
