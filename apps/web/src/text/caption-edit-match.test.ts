import { expect, test } from "bun:test";
import { captionTokens, editCaptionText, type CaptionData } from "./caption";

// The matching of the previous implementation (a full table, keys normalized in every cell).
const matchKey = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, "");
function referenceMatches(old: string[], tokens: string[]): number[] {
	const table = Array.from({ length: old.length + 1 }, () => new Uint32Array(tokens.length + 1));
	for (let i = old.length - 1; i >= 0; i--) {
		for (let j = tokens.length - 1; j >= 0; j--) {
			table[i][j] = matchKey(old[i]) === matchKey(tokens[j]) ? 1 + table[i + 1][j + 1] : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const matched = tokens.map(() => -1);
	let i = 0;
	let j = 0;
	while (i < old.length && j < tokens.length) {
		if (matchKey(old[i]) === matchKey(tokens[j])) matched[j++] = i++;
		else if (table[i + 1][j] >= table[i][j + 1]) i++;
		else j++;
	}
	return matched;
}

function random(seed: number) {
	return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

test("editing caption text keeps the same words' timings as the full matching did", () => {
	const next = random(7);
	const vocabulary = ["ya", "Ya!", "aku", "kamu", "menang", "kalah", "eh", "dua", "2", "ronde", "ini", "itu"];
	const pick = () => vocabulary[Math.floor(next() * vocabulary.length)];
	for (let run = 0; run < 300; run++) {
		const oldTexts = Array.from({ length: 5 + Math.floor(next() * 60) }, pick);
		// Words with gaps around them (also before the first and after the last), so a changed run
		// always has room and the retained words keep their exact times.
		const caption: CaptionData = { approximate: false, words: oldTexts.map((text, index) => ({ text, start: index + 1, end: index + 1.5 })) };
		const tokens = [...oldTexts];
		for (let edit = 0; edit < 1 + Math.floor(next() * 4); edit++) {
			const at = Math.floor(next() * (tokens.length + 1));
			const kind = next();
			if (kind < 0.4) tokens.splice(at, 0, pick());
			else if (kind < 0.7 && tokens.length > 1) tokens.splice(Math.min(at, tokens.length - 1), 1);
			else if (tokens.length) tokens[Math.min(at, tokens.length - 1)] = pick();
		}
		const text = tokens.join(" ");
		const expected = referenceMatches(oldTexts, captionTokens(text));
		const edited = editCaptionText(caption, text, oldTexts.length + 2, 0);
		expected.forEach((index, j) => {
			if (index >= 0) expect(edited.words[j]).toMatchObject({ start: index + 1, end: index + 1.5 });
			else expect(edited.words[j].approximate).toBe(true);
		});
	}
});

test("typing at the end of a long caption matches the whole shared start", () => {
	const words = Array.from({ length: 500 }, (_, index) => ({ text: `w${index}`, start: index, end: index + 0.5 }));
	const edited = editCaptionText({ approximate: false, words }, `${words.map(({ text }) => text).join(" ")} baru`, 501, 0);
	expect(edited.words.slice(0, 500)).toEqual(words);
	expect(edited.words[500]).toMatchObject({ text: "baru", approximate: true });
});
