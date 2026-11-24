import { promises as fs } from "node:fs";
import path from "node:path";
import { runProcess } from "@/retrieval/process";
import { fileProbeCommand, toolsFromEnv } from "@/retrieval/server";
import { cutPop, decibels, finding, meanDelta, REVIEW_LIMITS as L, type ReviewFinding } from "./review-findings";

export const REVIEW_WIDTH = 64, REVIEW_HEIGHT = 36;
const frameBytes = REVIEW_WIDTH * REVIEW_HEIGHT;
const rate = 8000;
const scanFilter = `scale=${REVIEW_WIDTH}:${REVIEW_HEIGHT}:flags=area,format=gray`;
const safeInput = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,m4v,ogg"];

export type Probe = { duration: number; width: number; height: number; fps: number; fpsRatio: string; variable: boolean; channels: number };
export type Interval = { from: number; to: number; value: number };
export type FileScan = {
	probe: Probe; frames: number; video: string; audio?: string; decodeError?: string;
	black: Interval[]; frozen: Interval[]; loudness: number | null; truePeak: number | null;
};

export async function probeReviewFile(file: string, signal: AbortSignal, root: string): Promise<Probe> {
	const [ffmpeg] = toolsFromEnv().ffmpeg;
	const [exe, ...args] = fileProbeCommand(ffmpeg);
	const { stdout } = await runProcess(exe, [...args, "-v", "error", ...safeInput,
		"-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,channels", "-of", "json", file], signal, root);
	const info = JSON.parse(stdout) as { format?: { duration: string }; streams?: {
		codec_type: string; width?: number; height?: number; channels?: number; avg_frame_rate?: string; r_frame_rate?: string;
	}[] };
	const video = info.streams?.find((stream) => stream.codec_type === "video");
	const fpsRatio = video?.avg_frame_rate ?? "";
	const [n, d] = fpsRatio.split("/").map(Number);
	const fps = n / d;
	const duration = Number(info.format?.duration);
	if (!video?.width || !video.height || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) {
		throw new Error("The exported file has no usable video timing or dimensions.");
	}
	const channels = info.streams?.find((stream) => stream.codec_type === "audio")?.channels ?? 0;
	if (!Number.isSafeInteger(channels) || channels < 0 || channels > 64) throw new Error("Unsupported audio channel count.");
	return { duration, width: video.width, height: video.height, fps, fpsRatio, variable: fpsRatio !== video.r_frame_rate, channels };
}

async function ffmpeg(args: string[], signal: AbortSignal, root: string) {
	const [exe, ...defaults] = toolsFromEnv().ffmpeg;
	return runProcess(exe, [...defaults, "-hide_banner", "-nostdin", "-threads", "2", "-filter_threads", "2", ...args], signal, root, { lowPriority: true });
}

export async function scanReviewFile(file: string, scratch: string, probe: Probe, signal: AbortSignal, root: string): Promise<FileScan> {
	const video = path.join(scratch, "frames.gray");
	const audio = probe.channels ? path.join(scratch, "audio.f32") : undefined;
	let decodeError: string | undefined;
	let logs: string;
	try {
		const result = await ffmpeg(["-loglevel", "info", "-nostats", "-xerror", ...safeInput, "-i", file,
			"-map", "0:v:0", "-an", "-vf", scanFilter, "-fps_mode", "passthrough", "-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", video,
			...(audio ? ["-map", "0:a:0", "-vn", "-af", `ebur128=peak=true:framelog=verbose,aresample=${rate}:async=1:first_pts=0`, "-f", "f32le", audio] : []),
		], signal, root);
		logs = result.stderr;
	} catch (error) {
		signal.throwIfAborted();
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
		logs = (error as { stderr?: string }).stderr ?? "";
		decodeError = logs.trim().split(/\r?\n/).at(-1) || (error instanceof Error ? error.message : String(error));
	}
	const loudness = /\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g;
	const peak = /\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/g;
	const last = (pattern: RegExp) => Number([...logs.matchAll(pattern)].at(-1)?.[1] ?? NaN);
	const i = last(loudness), p = last(peak);
	const handle = await fs.open(video, "r").catch((error: NodeJS.ErrnoException) => {
		if (decodeError && error.code === "ENOENT") return null;
		throw error;
	});
	const black: Interval[] = [], frozen: Interval[] = [];
	let frames = 0;
	if (handle) try {
		const bytes = Buffer.alloc(frameBytes * 64);
		let previous: Buffer | undefined, dark: Interval | undefined, still: Interval | undefined;
		const flush = (range: Interval | undefined, target: Interval[], minimum: number) => {
			if (range && range.to - range.from >= minimum - 1e-8) target.push(range);
		};
		for (;;) {
			signal.throwIfAborted();
			const { bytesRead } = await handle.read(bytes);
			for (let offset = 0; offset + frameBytes <= bytesRead; offset += frameBytes) {
				const current = bytes.subarray(offset, offset + frameBytes);
				const from = frames++ / probe.fps, to = frames / probe.fps;
				let count = 0;
				for (const pixel of current) if (pixel <= 16) count++;
				const fraction = count / frameBytes;
				const delta = previous ? meanDelta(previous, current) : Infinity;
				if (fraction >= L.blackFraction) dark = { from: dark?.from ?? from, to, value: Math.min(dark?.value ?? 1, fraction) };
				else { flush(dark, black, L.blackSeconds); dark = undefined; }
				if (delta <= L.freezeMeanDelta && fraction < L.blackFraction) {
					still = { from: still?.from ?? from - 1 / probe.fps, to, value: Math.max(still?.value ?? 0, delta) };
				} else { flush(still, frozen, L.freezeSeconds); still = undefined; }
				(previous ??= Buffer.alloc(frameBytes)).set(current);
			}
			if (bytesRead < bytes.length) break;
		}
		flush(dark, black, L.blackSeconds); flush(still, frozen, L.freezeSeconds);
	} finally { await handle.close(); }
	return { probe, frames, video, audio, decodeError, black, frozen, loudness: Number.isFinite(i) ? i : null, truePeak: Number.isFinite(p) ? p : null };
}

export async function sourceMotion(file: string, from: number, to: number, output: string, signal: AbortSignal, safeRoot: string) {
	await ffmpeg(["-loglevel", "error", "-y", ...safeInput, "-ss", String(Math.max(0, from)), "-i", file, "-t", String(to - from),
		"-an", "-vf", `fps=4,${scanFilter}`, "-frames:v", "32", "-threads", "1", "-f", "rawvideo", output], signal, safeRoot);
	const bytes = await fs.readFile(output);
	const frames = Math.floor(bytes.length / frameBytes);
	let maximum = 0;
	for (let i = 1; i < frames; i++) maximum = Math.max(maximum, meanDelta(bytes.subarray(0, frameBytes), bytes.subarray(i * frameBytes, (i + 1) * frameBytes)));
	return maximum;
}

export async function inspectAudio(scan: FileScan, cuts: { at: number; elementIds: string[] }[], signal: AbortSignal) {
	const findings: ReviewFinding[] = [];
	if (!scan.audio) return findings;
	const { duration, channels } = scan.probe;
	const { loudness, truePeak } = scan;
	const outside = loudness !== null && (loudness < L.loudnessLow || loudness > L.loudnessHigh) || truePeak !== null && truePeak > L.truePeak;
	findings.push(finding("audio-levels", outside ? "warning" : "info", 0, duration,
		{ integratedLufs: loudness, truePeakDbtp: truePeak, minLufs: L.loudnessLow, maxLufs: L.loudnessHigh, maxTruePeak: L.truePeak }));
	const handle = await fs.open(scan.audio, "r").catch((error: NodeJS.ErrnoException) => {
		if (scan.decodeError && error.code === "ENOENT") return null;
		throw error;
	});
	if (!handle) return findings;
	try {
		const bytesPerFrame = channels * 4;
		const total = Math.floor((await handle.stat()).size / bytesPerFrame);
		const read = async (start: number, count: number) => {
			const samples = new Float32Array(count * channels);
			await handle.read(new Uint8Array(samples.buffer), 0, samples.byteLength, start * bytesPerFrame);
			return samples;
		};
		const wing = Math.ceil(rate * (L.popNeighbors + L.popSeconds / 2));
		for (const { at, elementIds } of cuts) {
			signal.throwIfAborted();
			const frame = Math.round(at * rate);
			if (frame < wing || frame + wing > total) continue;
			const pop = cutPop(await read(frame - wing, wing * 2), rate, wing, channels);
			if (pop) findings.push(finding("cut-click", "warning", at, at, pop, elementIds));
		}
		for (const trailing of [false, true]) {
			let seconds = 0;
			const block = rate / 100;
			const batch = rate;
			for (let offset = 0; offset < total; offset += batch) {
				signal.throwIfAborted();
				const count = Math.min(batch, total - offset);
				const start = trailing ? total - offset - count : offset;
				const pcm = await read(start, count);
				let stopped = false;
				for (let index = 0; index + block <= count; index += block) {
					const from = trailing ? count - index - block : index;
					let peak = 0;
					for (let p = from * channels; p < (from + block) * channels; p++) peak = Math.max(peak, Math.abs(pcm[p]));
					if (decibels(peak) >= L.silenceDb) { stopped = true; break; }
					seconds += block / rate;
				}
				if (stopped) break;
			}
			if (seconds >= L.silenceSeconds - 1e-8) findings.push(finding(trailing ? "silent-outro" : "silent-intro", "info",
				trailing ? Math.max(0, duration - seconds) : 0, trailing ? duration : seconds, { seconds, belowDb: L.silenceDb }));
		}
	} finally { await handle.close(); }
	return findings;
}
