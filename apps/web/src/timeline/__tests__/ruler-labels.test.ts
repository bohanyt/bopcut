import { describe, expect, test } from "bun:test";
import { formatRulerLabel, getRulerConfig, shouldShowLabel } from "@/timeline/ruler-utils";

const RATES = [
	{ numerator: 24000, denominator: 1001 },
	{ numerator: 25, denominator: 1 },
	{ numerator: 30000, denominator: 1001 },
	{ numerator: 30, denominator: 1 },
	{ numerator: 60000, denominator: 1001 },
];
const ZOOMS = [0.1, 0.25, 0.5, 1, 1.5, 2.4, 4, 8, 16, 40, 100];

/** The labels the ruler draws in the first `seconds`, generated like timeline-ruler.tsx does. */
function labels(fps: (typeof RATES)[number], zoomLevel: number, seconds: number) {
	const { labelIntervalSeconds, tickIntervalSeconds } = getRulerConfig({ zoomLevel, fps });
	const drawn: { time: number; label: string }[] = [];
	for (let index = 0; index * tickIntervalSeconds <= seconds; index++) {
		const time = index * tickIntervalSeconds;
		if (shouldShowLabel({ time, labelIntervalSeconds })) drawn.push({ time, label: formatRulerLabel({ timeInSeconds: time, fps }) });
	}
	return { labelIntervalSeconds, drawn };
}

describe("ruler labels", () => {
	for (const fps of RATES) {
		const rate = fps.numerator / fps.denominator;
		test.each(ZOOMS)(`${rate.toFixed(3)} fps at zoom %p labels every interval`, (zoomLevel) => {
			const seconds = Math.min(600, Math.max(2, 4000 / (50 * zoomLevel)));
			const { labelIntervalSeconds, drawn } = labels(fps, zoomLevel, seconds);
			if (labelIntervalSeconds >= 1) {
				// Whole-second labels: each one is drawn, on its second.
				const expected = [];
				for (let time = 0; time <= seconds + 1e-9; time += labelIntervalSeconds) expected.push(Math.round(time));
				expect(drawn.map(({ time }) => Math.round(time))).toEqual(expected);
				for (const { time, label } of drawn) expect(label).toMatch(/^(\d+:)?\d\d:\d\d$/);
				return;
			}
			expect(drawn.length).toBeGreaterThan(1);
			for (const { time, label } of drawn) {
				const frame = Math.round(time * rate);
				const second = Math.floor(frame / rate + 1e-9);
				const firstFrame = Math.ceil(second * rate - 1e-9);
				expect(label).not.toBe("0f");
				if (frame === firstFrame) expect(label).toMatch(/^\d\d:\d\d$/);
				else expect(label).toBe(`${frame - firstFrame}f`);
			}
		});
	}

	test("the frame just before a second keeps its frame label", () => {
		const fps = { numerator: 60000, denominator: 1001 };
		// Frame 2997 starts 0.00005 s before second 50 (2997.003 frames): it is frame 59 of second 49.
		const time = (2997 * 1001) / 60000;
		expect(50 - time).toBeLessThan(0.0001);
		expect(formatRulerLabel({ timeInSeconds: time, fps })).toBe("59f");
		expect(formatRulerLabel({ timeInSeconds: (2998 * 1001) / 60000, fps })).toBe("00:50");
	});

	test("hours are kept", () => {
		expect(formatRulerLabel({ timeInSeconds: 3725, fps: { numerator: 30, denominator: 1 } })).toBe("1:02:05");
	});
});

test("whole-second labels at 29.97 fps keep ticks between them", () => {
	const { labelIntervalSeconds, tickIntervalSeconds } = getRulerConfig({ zoomLevel: 2.4, fps: { numerator: 30000, denominator: 1001 } });
	expect(labelIntervalSeconds).toBe(1);
	expect(tickIntervalSeconds).toBeLessThan(1);
	expect(Number.isInteger(Math.round(1e9 / tickIntervalSeconds) / 1e9)).toBe(true);
});
