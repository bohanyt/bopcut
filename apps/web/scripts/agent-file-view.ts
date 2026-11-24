import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { fileInside, inside } from "../src/agent/inside";
import { accumulatePeaks, drawRangeView, MAX_RANGE_PNG, rangeRows, RANGE_BUCKETS, RANGE_FRAME_WIDTH, RANGE_HEADER, RANGE_ROW_HEIGHT, RANGE_WIDTH, type RangeInput } from "../src/agent/range-view";
import { parseSourceWords } from "../src/media/words";
import { runProcess, withToolScratch } from "../src/retrieval/process";
import { toolsFromEnv } from "../src/retrieval/server";
import { parseTime } from "../src/retrieval/time";
import { atomicWrite } from "../src/services/storage/server/files";

export function checkFileRange(to: number, ffmpegInfo: string) {
	const stamp = /^\s+Duration: (\d+:\d+:\d+\.\d+),/m.exec(ffmpegInfo)?.[1];
	const duration = stamp ? parseTime(stamp) : NaN;
	if (!Number.isFinite(duration)) throw new Error("Could not determine the video duration. Use a file with a known duration.");
	if (to > duration) throw new Error("The range ends outside the video file.");
}

export async function fileRangeView(relative: string, input: RangeInput, workspace: string, filesRoot: string, signal: AbortSignal) {
	relative = path.relative(filesRoot, inside(filesRoot, relative));
	const file = await fileInside(filesRoot, relative);
	if (!file) throw new Error("The video was not found under AGENT_FILES_ROOT.");
	const [ffmpeg, ...defaults] = toolsFromEnv(process.env).ffmpeg;
	const rate = 8_000;
	return withToolScratch(signal, filesRoot, async (scratch, active) => {
		const run = (seek: number, args: string[], loglevel = "error") => runProcess(ffmpeg, [...defaults, "-hide_banner", "-loglevel", loglevel,
			"-y", "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,m4v,ogg",
			"-ss", String(seek), "-i", file, ...args], active, filesRoot);
		const info = await run(0, ["-map", "0:v:0", "-t", "0", "-c:v", "copy", "-f", "null", "-"], "info");
		checkFileRange(input.to, info.stderr);
		const tile = path.join(scratch, "%03d.jpg");
		const rows = rangeRows(input);
		const span = input.to - input.from;
		const fps = input.rows / span;
		const tileHeight = 90;
		await run(rows[0].time, ["-an", "-vf",
			`fps=fps=${fps}:start_time=0:round=up,scale=${RANGE_FRAME_WIDTH}:${tileHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${RANGE_FRAME_WIDTH}:${tileHeight}:(ow-iw)/2:(oh-ih)/2`,
			"-frames:v", String(input.rows), "-threads", "1", tile]);
		const frames = await Promise.all(rows.map(async (_, i) => {
			const frame = path.join(scratch, `${String(i + 1).padStart(3, "0")}.jpg`);
			return loadImage(frame).catch(() => { throw new Error("The file cannot show all requested frames. Shorten the range."); });
		}));
		const pcm = path.join(scratch, "audio.f32");
		// Audio packets keep their offset from the video after seeking. Pad to range time zero.
		await run(input.from, ["-map", "0:a:0?", "-vn", "-t", String(span), "-ac", "1",
			"-af", `aresample=${rate}:async=1:first_pts=0`, "-f", "f32le", pcm]).catch((error: Error & { stderr?: string }) => {
			if (!/does not contain any stream|matches no streams/i.test(error.stderr ?? "")) throw error;
		});
		const audio = await fs.readFile(pcm).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return Buffer.alloc(0);
			throw error;
		});
		const peaks = new Float32Array(input.rows * RANGE_BUCKETS);
		accumulatePeaks(peaks, new Float32Array(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength)), 0, Math.ceil(span * rate));
		const sidecar = await fileInside(filesRoot, relative + ".words.json");
		const words = sidecar ? parseSourceWords(JSON.parse(await fs.readFile(sidecar, "utf8"))) : [];
		if (!words) throw new Error("Invalid source words sidecar.");
		const canvas = createCanvas(RANGE_WIDTH, RANGE_HEADER + RANGE_ROW_HEIGHT * input.rows);
		const ctx = canvas.getContext("2d");
		drawRangeView(ctx, input, { title: path.basename(file), peaks, words, spans: [], frames: frames.map((image) =>
			(x, y, w, h) => ctx.drawImage(image, x, y, w, h)) });
		const bytes = await canvas.encode("png");
		if (bytes.length > MAX_RANGE_PNG) throw new Error("The range picture exceeds the PNG size limit.");
		const views = path.join(workspace, "views");
		await fs.mkdir(views, { recursive: true });
		if (!(await fs.lstat(views)).isDirectory()) throw new Error("The views folder must be a directory.");
		const output = `views/file-${randomUUID()}.png`;
		await atomicWrite(path.join(workspace, output), bytes, active);
		return { file: output, bytes: bytes.length, ...input };
	}, workspace);
}
