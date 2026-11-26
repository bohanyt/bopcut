import { expect, test } from "bun:test";
import { parseAss } from "@/subtitles/ass";
import { localizeErrorDetail } from "@/i18n/error-details";
import { createTranslator } from "@/i18n/translate";

const ASS = [
	"[Script Info]",
	"PlayResX: 1920",
	"PlayResY: 1080",
	"",
	"[V4+ Styles]",
	"Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
	"Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,150,100,0,15,1,3,2,2,10,10,10,1",
	"",
	"[Events]",
	"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
	"Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,Banner;10,{\\b1}Halo{\\b0} semua",
	"Dialogue: 0,0:00:02.00,0:00:03.00,Missing,,0,0,0,,Kedua",
	"Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,catatan",
].join("\n");

test("every ASS import warning is shown in Indonesian", () => {
	const { warnings } = parseAss({ input: ASS });
	expect(warnings).toHaveLength(5);
	const id = createTranslator("id");
	const en = createTranslator("en");
	for (const warning of warnings) {
		const shown = localizeErrorDetail(warning, id);
		expect(shown).not.toBe(warning);
		expect(shown).not.toContain("{");
		// The counts survive the translation.
		for (const count of warning.match(/\d+/g) ?? []) expect(shown).toContain(count);
		expect(localizeErrorDetail(warning, en)).not.toContain("{");
	}
});
