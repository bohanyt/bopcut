import { expect, test } from "bun:test";
import { resolveLocale, type Locale } from "./locale";

const cases: [string, string | undefined, string | null, Locale][] = [
	["Indonesian language", undefined, "id", "id"],
	["Indonesian region and case", undefined, "ID-ID,en;q=0.8", "id"],
	["English browser with Indonesian as a fallback", undefined, "en-US,id;q=0.9", "en"],
	["unsupported preferred language", undefined, "fr,id;q=0.9", "en"],
	["higher quality Indonesian entry", undefined, "en;q=0.6,id-ID;q=0.9", "id"],
	["explicitly rejected Indonesian", undefined, "id;q=0", "en"],
	["missing browser preference", undefined, null, "en"],
	["Indonesian saved choice", "id", "en-US", "id"],
	["English saved choice", "en", "id-ID", "en"],
	["invalid saved choice", "fr", "id-ID", "id"],
];

test.each(cases)("%s", (_label, cookie, acceptLanguage, expected) => {
	expect(resolveLocale(cookie, acceptLanguage)).toBe(expected);
});
