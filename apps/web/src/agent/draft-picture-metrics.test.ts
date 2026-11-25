import { expect, test } from "bun:test";
import { parseArgs } from "../../scripts/agent";
import { activePictureFrame, pictureBytes, pictureEvents, pictureFeature, pictureHeight, pictureMatch, pictureWidth } from "./draft-picture-metrics";

function pattern(offset = 0, crop = 1) {
	const rgb = new Uint8Array(pictureBytes);
	for (let y = 0; y < pictureHeight; y++) for (let x = 0; x < pictureWidth; x++) {
		const u = (x / pictureWidth - 0.5) * crop + 0.5, v = (y / pictureHeight - 0.5) * crop + 0.5;
		const box = Math.abs(u - 0.35 - offset) < 0.13 && Math.abs(v - 0.5) < 0.21;
		const dot = (u - 0.7) ** 2 + (v - 0.33) ** 2 < 0.009;
		const i = (y * pictureWidth + x) * 3;
		rgb.set(box ? [148, 90, 76] : dot ? [41, 108, 192] : [41, 53, 62], i);
	}
	return pictureFeature(rgb);
}

test("two corresponding samples identify a small crop and reject a shared midpoint", () => {
	const a = [pattern(), pattern(0.05), pattern(0.1)];
	const cropped = [pattern(0, 0.94), pattern(0.05, 0.94), pattern(0.1, 0.94)];
	expect(pictureMatch(a, cropped, 0.038)?.matches).toBe(3);
	expect(pictureMatch(a, [pattern(0.35), a[1], pattern(0.3)], 0.038)).toBeUndefined();
	expect(pictureMatch(a, [a[0], pattern(0.4), a[2]], 0.038)?.evidenceIndex).toBe(0);
});

const rgb = (value: number) => new Uint8Array(pictureBytes).fill(value);
const pause = (value: number, length = 15) => Array<number>(length).fill(value);
const freeze = (step: number) =>
	[20, 20 + step, 20 + 2 * step, ...pause(20 + 3 * step), 20 + 4 * step, 20 + 5 * step, 20 + 6 * step];

for (const [name, values, expected] of [
	["freeze in a slow pan (about 0.012 RMS/frame)", freeze(3), true],
	["freeze in fast motion (about 0.047 RMS/frame)", freeze(12), true],
	["static slide between cuts", [30, 35, 40, 45, ...pause(220), 50, 55, 60, 65], false],
	["UI recording with clicks", [...pause(45, 8), ...pause(48, 8), ...pause(41, 8), ...pause(55, 8)], false],
	["animation on twos", Array.from({ length: 32 }, (_, i) => 30 + 6 * Math.floor(i / 2)), false],
	["deliberate hold at the end of a move", [30, 40, 50, 60, ...pause(70)], false],
] as const) {
	test(name, () => {
		const frames = values.map((value, i) => ({ at: i / 30, rgb: rgb(value) }));
		const events = pictureEvents(frames, 0.35, 0.2).filter(event => event.kind === "frozen-stretch");
		expect(events).toHaveLength(expected ? 1 : 0);
		if (expected) expect(events[0]).toMatchObject({ from: 3 / 30, to: 18 / 30, frames: 15 });
	});
}

test("uses VFR presentation times for the active frame and outlier interval", () => {
	const frames = [0, 0.07, 0.26].map((at, i) => ({ at, rgb: rgb(i === 1 ? 250 : 31) }));
	expect(activePictureFrame(frames, 0.09, 0.8)).toBe(frames[1]);
	expect(activePictureFrame(frames, 0.3, 0.8)).toBe(frames[2]);
	expect(activePictureFrame(frames, 0.3, 0.8, true)).toBeUndefined();
	expect(activePictureFrame(frames, 0.8, 0.8)).toBeUndefined();
	expect(pictureEvents(frames, 0.35, 0.2)).toEqual([
		expect.objectContaining({ kind: "single-frame-outlier", from: 0.07, to: 0.26 }),
	]);
});

test("flat and dark samples cannot vote for a look-alike pair", () => {
	const black = pictureFeature(rgb(0));
	const flat = pictureFeature(rgb(50));
	const informative = pattern();
	expect(pictureMatch([black, flat, informative], [black, flat, informative], 0.038)).toBeUndefined();
	expect(pictureMatch([black, informative, informative], [black, informative, informative], 0.038)?.matches).toBe(2);
});

test("compares small changes to a text card on a shared background", () => {
	const card = (crossbar: boolean) => {
		const frame = rgb(48);
		for (let y = 23; y < 33; y++) for (let x = 42; x < 58; x++) {
			if (x <= 43 || x >= 55 || (crossbar && y >= 25 && y < 28)) {
				const p = (y * pictureWidth + x) * 3;
				frame.fill(180, p, p + 3);
			}
		}
		return pictureFeature(frame);
	};
	const a = Array(3).fill(card(false)), b = Array(3).fill(card(true));
	expect(pictureMatch(a, a, 0.038)?.matches).toBe(3);
	expect(pictureMatch(a, b, 0.038)).toBeUndefined();
});

test("picture options require the opt-in and limit the number of shots", () => {
	expect(parseArgs(["draft-check", "--project-id", "demo", "--pictures", "--picture-limit", "30", "--freeze-seconds", "0.5"]))
		.toMatchObject({ pictures: { limit: 30, freezeSeconds: 0.5 }, timeoutMs: 55_000 });
	expect(() => parseArgs(["draft-check", "--project-id", "demo", "--picture-limit", "1"])).toThrow("requires --pictures");
	expect(() => parseArgs(["draft-check", "--project-id", "demo", "--pictures", "--picture-limit", "301"])).toThrow("1 to 300");
});
