import { expect, test } from "bun:test";
import { parseArgs } from "../../scripts/agent";
import { pictureBytes, pictureEvents, pictureFeature, pictureHeight, pictureMatch, pictureWidth } from "./draft-picture-metrics";

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

test("detects a freeze and a single-frame outlier inside moving source frames", () => {
	const frames = [20, 100, 100, 100, 100, 100, 180, 30, 250, 31, 54].map((value, i) => ({
		at: i / 10, duration: 0.1, rgb: new Uint8Array(pictureBytes).fill(value),
	}));
	const events = pictureEvents(frames, 0.35, 0.2);
	expect(events.map(({ kind, from, to, frames }) => ({ kind, from, to, frames }))).toEqual([
		{ kind: "frozen-stretch", from: 0.1, to: 0.6, frames: 5 },
		{ kind: "single-frame-outlier", from: 0.8, to: 0.9, frames: 1 },
	]);
	expect(pictureEvents(frames.slice(1, 7), 0.35, 0.2)).toEqual([]);
	expect(pictureEvents([frames[7], frames[8], { ...frames[9], at: 1.5 }], 0.35, 0.2)).toEqual([]);
});

test("picture options require the opt-in and limit the number of shots", () => {
	expect(parseArgs(["draft-check", "--project-id", "demo", "--pictures", "--picture-limit", "30", "--freeze-seconds", "0.5"]))
		.toMatchObject({ pictures: { limit: 30, freezeSeconds: 0.5 }, timeoutMs: 55_000 });
	expect(() => parseArgs(["draft-check", "--project-id", "demo", "--picture-limit", "1"])).toThrow("requires --pictures");
	expect(() => parseArgs(["draft-check", "--project-id", "demo", "--pictures", "--picture-limit", "301"])).toThrow("1 to 300");
});
