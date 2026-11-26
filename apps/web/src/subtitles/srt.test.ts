import { describe, expect, test } from "bun:test";
import { parseSrt } from "./srt";

const cues = (input: string) => {
	const { captions, skippedCueCount } = parseSrt({ input });
	return { skipped: skippedCueCount, cues: captions.map(({ text, startTime, duration }) => [text, startTime, duration]) };
};

describe("SRT import", () => {
	test("positioning after the end time is ignored", () => {
		expect(cues([
			"1", "00:00:01,000 --> 00:00:04,000 position:50.00% line:90.00%", "Centered",
			"",
			"2", "00:00:05,000 --> 00:00:06,500  X1:100 X2:600 Y1:400 Y2:450", "Legacy box",
		].join("\n"))).toEqual({ skipped: 0, cues: [["Centered", 1, 3], ["Legacy box", 5, 1.5]] });
	});

	test("hours may have one or more digits", () => {
		expect(cues(["1", "1:05:00,000 --> 1:05:02,000", "After one hour", "", "2", "100:00:00,000 --> 100:00:01,000", "Long"].join("\n")))
			.toEqual({ skipped: 0, cues: [["After one hour", 3900, 2], ["Long", 360000, 1]] });
	});

	test("cues without index lines or blank lines between them stay separate", () => {
		expect(cues(["1", "00:00:00,000 --> 00:00:01,000", "First", "00:00:01,000 --> 00:00:02,000", "Second"].join("\n")))
			.toEqual({ skipped: 0, cues: [["First", 0, 1], ["Second", 1, 1]] });
		expect(cues(["00:00:00,000 --> 00:00:01,000", "One", "two lines", "3", "00:00:02,000 --> 00:00:03,000", "Three"].join("\n")))
			.toEqual({ skipped: 0, cues: [["One\ntwo lines", 0, 1], ["Three", 2, 1]] });
	});

	test("a number that is not followed by a timestamp stays text, and broken blocks count as skipped", () => {
		expect(cues(["1", "00:00:00,000 --> 00:00:01,000", "Count", "10", "", "garbage", "more", "", "2", "00:00:03,000 --> 00:00:02,000", "Backwards"].join("\n")))
			.toEqual({ skipped: 2, cues: [["Count\n10", 0, 1]] });
	});
});
