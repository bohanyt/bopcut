import { expect, test } from "bun:test";
import { formatMediaTimecode, mediaTime, parseMediaTimecode } from "./media-time";

test.each([
	[24_000, 5_005, "00:00:20:00", 480],
	[30_000, 4_004, "00:00:20:00", 600],
	[60_000, 2_002, "00:00:20:00", 1_200],
	[30_000, 4_004, "01:00:00:00", 108_000],
] as const)("round-trips fractional frame times at %d/1001", (numerator, frameTicks, label, frame) => {
	const fps = { numerator, denominator: 1_001 };
	const time = mediaTime({ ticks: frame * frameTicks });
	const format = "HH:MM:SS:FF";
	expect(formatMediaTimecode({ time, format, fps })).toBe(label);
	expect(parseMediaTimecode({ timeCode: label, format, fps })).toBe(time);
});

test("keeps integer frame timecode and wall-clock formats", () => {
	const fps = { numerator: 30, denominator: 1 };
	const time = mediaTime({ ticks: 180_000 });
	expect(formatMediaTimecode({ time, format: "HH:MM:SS:FF", fps })).toBe("00:00:01:15");
	expect(parseMediaTimecode({ timeCode: "00:00:01:15", format: "HH:MM:SS:FF", fps })).toBe(time);
	expect(formatMediaTimecode({ time, format: "HH:MM:SS:CS", fps })).toBe("00:00:01:50");
	expect(parseMediaTimecode({ timeCode: "00:00:01:30", format: "HH:MM:SS:FF", fps })).toBeNull();
});
