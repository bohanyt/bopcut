import { expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { RANGE_FRAME_WIDTH, RANGE_HEADER, RANGE_ROW_HEIGHT, RANGE_WIDTH } from "../src/agent/range-view";
import { fileProbeCommand, toolsFromEnv } from "../src/retrieval/server";
import { checkFileRange, fileRangeView } from "./agent-file-view";

test("the file range check rejects a tail beyond the duration and unknown durations", () => {
	const info = (duration: string) => JSON.stringify({ format: { duration }, streams: [{ codec_type: "video" }] });
	const check = (to: number, probe = info("4.000000")) => checkFileRange({ from: 0, to, rows: 1 }, probe);
	expect(check(4)).toBe(0);
	expect(check(1.001, info("1.001000"))).toBe(0);
	expect(() => check(4.001)).toThrow("ends outside the video file");
	expect(() => check(4, info("N/A"))).toThrow("determine the video duration");
});

const [ffmpeg, ...defaults] = toolsFromEnv(process.env).ffmpeg;
const [ffprobe] = fileProbeCommand(ffmpeg);
const toolsMissing = [ffmpeg, ffprobe].some((command) => !Bun.which(command) && !existsSync(command));
async function makeVideo(args: string[], output: string) {
	const fixture = Bun.spawn([ffmpeg, ...defaults, "-hide_banner", "-loglevel", "error", "-y",
		...args, "-c:v", "mpeg4", "-threads", "1", output,
	], { stderr: "pipe", stdout: "ignore" });
	const error = await new Response(fixture.stderr).text();
	if (await fixture.exited) throw new Error(error);
}

test.skipIf(toolsMissing)("delayed opposite-polarity stereo stays audible at its own time after seeking", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-file-view-"));
	try {
		await makeVideo([
			"-f", "lavfi", "-i", "color=s=160x90:r=12:d=4", "-itsoffset", "2",
			"-f", "lavfi", "-i", "aevalsrc=0.5*sin(2*PI*440*t)|-0.5*sin(2*PI*440*t):s=48000:d=1",
			"-c:a", "pcm_s16le",
		], path.join(root, "delayed.mov"));

		const input = { from: 1, to: 3.5, rows: 1 };
		const result = await fileRangeView("delayed.mov", input, root, root, AbortSignal.timeout(15_000));
		const image = await loadImage(path.join(root, result.file));
		const ctx = createCanvas(image.width, image.height).getContext("2d");
		ctx.drawImage(image, 0, 0);
		const left = RANGE_FRAME_WIDTH + 36, right = RANGE_WIDTH - 18;
		const at = (time: number) => Math.round(left + (right - left) * (time - input.from) / (input.to - input.from));
		const hasWave = (start: number, end: number) => {
			const pixels = ctx.getImageData(at(start), RANGE_HEADER + 33, at(end) - at(start), 6).data;
			for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 101 && pixels[i + 1] === 210 && pixels[i + 2] === 191) return true;
			return false;
		};
		expect(hasWave(1, 1.7)).toBe(false);
		expect(hasWave(2.2, 2.8)).toBe(true);
		await expect(fileRangeView("delayed.mov", { from: 3, to: 4.25, rows: 1 }, root, root, AbortSignal.timeout(8_000)))
			.rejects.toThrow("ends outside the video file");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 25_000);

test.skipIf(toolsMissing)("file views use the frame covering the midpoint, including exact end ranges", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-file-tail-"));
	try {
		const middle = "drawbox=color=blue:t=fill:enable=gte(t\\,3.916)";
		await makeVideo(["-f", "lavfi", "-i", "color=red:s=160x90:r=12:d=4", "-vf", middle], path.join(root, "short.mov"));
		const view = (file: string, from: number, to: number, rows = 1) =>
			fileRangeView(file, { from, to, rows }, root, root, AbortSignal.timeout(15_000));
		const result = await view("short.mov", 3.8, 4, 2);
		const image = await loadImage(path.join(root, result.file));
		const ctx = createCanvas(image.width, image.height).getContext("2d");
		ctx.drawImage(image, 0, 0);
		const first = ctx.getImageData(110, RANGE_HEADER + 50, 1, 1).data;
		const second = ctx.getImageData(110, RANGE_HEADER + 50 + RANGE_ROW_HEIGHT, 1, 1).data;
		expect(first[0]).toBeGreaterThan(200);
		expect(first[2]).toBeLessThan(30);
		expect(second[2]).toBeGreaterThan(200);
		expect(second[0]).toBeLessThan(30);
		expect((await view("short.mov", 3.9, 4)).bytes).toBeGreaterThan(0);

		await makeVideo(["-f", "lavfi", "-i", "color=s=16x16:r=2:d=3600"], path.join(root, "hour.mov"));
		expect((await view("hour.mov", 3599.5, 3600)).bytes).toBeGreaterThan(0);
		await makeVideo(["-f", "lavfi", "-i", "color=s=16x16:r=30000/1001", "-frames:v", "30"], path.join(root, "exact.mov"));
		expect((await view("exact.mov", 0.9, 1.001)).bytes).toBeGreaterThan(0);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);
