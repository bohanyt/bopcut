import { expect, test } from "bun:test";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import { buildSubtitleTextElement } from "./build-subtitle-text-element";
import type { SubtitleStyleOverrides } from "./types";

const SUBTITLE_FONT_SIZE = 5;

function resolvedFontSize(style: SubtitleStyleOverrides | undefined): number {
	return buildSubtitleTextElement({
		index: 0,
		caption: { text: "Caption", startTime: 0, duration: 1, style },
		canvasSize: { width: 640, height: 360 },
		ctx: null,
	}).params.fontSize as number;
}

test("invalid subtitle font sizes fall back to SUBTITLE_FONT_SIZE", () => {
	for (const style of [
		{ fontSizeRatioOfPlayHeight: 0 },
		{ fontSizeRatioOfPlayHeight: -0.1 },
		{ fontSizeRatioOfPlayHeight: Number.NaN },
		{ fontSize: 0 },
	] satisfies SubtitleStyleOverrides[]) {
		expect(resolvedFontSize(style)).toBe(SUBTITLE_FONT_SIZE);
	}
});

test("valid subtitle font sizes are unchanged", () => {
	expect(
		resolvedFontSize({ fontSizeRatioOfPlayHeight: 0.05 }),
	).toBe(0.05 * FONT_SIZE_SCALE_REFERENCE);
	expect(resolvedFontSize({ fontSize: 40 })).toBe(40);
});