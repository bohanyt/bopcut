import { expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { RANGE_FRAME_WIDTH, RANGE_HEADER, RANGE_WIDTH } from "../src/agent/range-view";
import { toolsFromEnv } from "../src/retrieval/server";
import { checkFileRange, fileRangeView } from "./agent-file-view";

test("the file range check rejects a tail beyond the duration and unknown durations", () => {
	const info = "Input #0, mov, from 'clip.mp4':\n  Duration: 00:00:04.00, start: 0.000000, bitrate: 19 kb/s";
	expect(() => checkFileRange(4, info)).not.toThrow();
	expect(() => checkFileRange(4.001, info)).toThrow("ends outside the video file");
	expect(() => checkFileRange(4.25, info)).toThrow("ends outside the video file");
	expect(() => checkFileRange(4, "  Duration: N/A, start: 0.000000")).toThrow("determine the video duration");
});

const [ffmpeg, ...defaults] = toolsFromEnv(process.env).ffmpeg;
test.skipIf(!Bun.which(ffmpeg) && !existsSync(ffmpeg))("a delayed audio stream stays at its own time after seeking", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-file-view-"));
	try {
		const clip = path.join(root, "delayed.mp4");
		const fixture = Bun.spawn([ffmpeg, ...defaults, "-hide_banner", "-loglevel", "error", "-y",
			"-f", "lavfi", "-i", "color=s=160x90:r=12:d=4", "-itsoffset", "2",
			"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
			"-c:v", "mpeg4", "-c:a", "aac", "-threads", "1", clip,
		], { stderr: "pipe", stdout: "ignore" });
		const error = await new Response(fixture.stderr).text();
		if (await fixture.exited) throw new Error(error);

		const input = { from: 1, to: 3.5, rows: 1 };
		const result = await fileRangeView("delayed.mp4", input, root, root, AbortSignal.timeout(15_000));
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
		await expect(fileRangeView("delayed.mp4", { from: 3, to: 4.25, rows: 1 }, root, root, AbortSignal.timeout(8_000)))
			.rejects.toThrow("ends outside the video file");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 25_000);
