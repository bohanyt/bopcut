import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { floatToFrameRate, frameRateToFloat } from "@/fps/utils";
import { runProcess } from "@/retrieval/process";
import { fileProbeCommand, toolsFromEnv } from "@/retrieval/server";
import { cutPop, decibels, finding, meanDelta, REVIEW_LIMITS as L, type ReviewFinding } from "./review-findings";

export const REVIEW_WIDTH = 64, REVIEW_HEIGHT = 36;
const frameBytes = REVIEW_WIDTH * REVIEW_HEIGHT;
const scanFilter = `scale=${REVIEW_WIDTH}:${REVIEW_HEIGHT}:flags=area,format=gray`;
const safeInput = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,webm,avi,mpegts,mpeg,m4v,ogg,wav,mp3,aac,flac"];

export type Probe = { duration: number; streamDuration: number | null; width: number; height: number; fps: number; fpsRatio: string; channels: number; sampleRate: number };
export type Interval = { from: number; to: number; value: number };
type Stamp = { at: number; duration: number };
export type FileScan = {
	probe: Probe; frames: number; video: string; audio?: string; decodeError?: string;
	black: Interval[]; frozen: Interval[]; loudness: number | null; truePeak: number | null;
	stamps: Stamp[]; videoDuration: number; videoEnd: number; fps: number; variable: boolean;
};

export function frameCadence(stamps: Stamp[], fallback: number) {
	const steps = stamps.slice(1, stamps.length > 2 ? -1 : undefined).map((frame, i) => frame.at - stamps[i].at)
		.filter((step) => step > 0).sort((a, b) => a - b);
	const step = steps.length ? (steps[(steps.length - 1) >> 1] + steps[steps.length >> 1]) / 2 : 1 / fallback;
	const variable = steps.some((value) => Math.abs(value - step) > 0.0015);
	const last = stamps.at(-1);
	const fps = frameRateToFloat(floatToFrameRate(1 / step));
	return { videoDuration: last ? last.at + (last.duration || step) - stamps[0].at : 0, fps, variable };
}

export function frameAt(stamps: Stamp[], time: number) {
	let low = 0, high = stamps.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (stamps[middle].at <= time + 0.000001) low = middle + 1;
		else high = middle;
	}
	return Math.max(0, low - 1);
}

async function readStamps(file: string, signal: AbortSignal) {
	const input = createReadStream(file, { signal });
	const lines = createInterface({ input, crlfDelay: Infinity });
	const result: Stamp[] = [];
	let unit = 0;
	for await (const line of lines) {
		const timeBase = /^#tb 0:\s*(\d+)\/(\d+)/.exec(line);
		if (timeBase) unit = Number(timeBase[1]) / Number(timeBase[2]);
		if (!line.startsWith("0,")) continue;
		const [, , pts, duration] = line.split(",");
		if (unit && Number.isFinite(Number(pts))) result.push({ at: Number(pts) * unit, duration: Number(duration) * unit || 0 });
	}
	return result;
}

const grayOutputs = (video: string, timing: string) => [
	"-filter_complex", `[0:v:0]${scanFilter},settb=AVTB,split[raw][timing]`,
	"-map", "[raw]", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-c:v", "rawvideo", "-threads", "1", "-f", "rawvideo", video,
	"-map", "[timing]", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-c:v", "rawvideo", "-threads", "1", "-f", "framecrc", timing,
];

export async function probeReviewFile(file: string, signal: AbortSignal, root: string): Promise<Probe> {
	const [ffmpeg] = toolsFromEnv().ffmpeg;
	const [exe, ...args] = fileProbeCommand(ffmpeg);
	const { stdout } = await runProcess(exe, [...args, "-v", "error", ...safeInput,
		"-show_entries", "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate,duration,channels,sample_rate", "-of", "json", file], signal, root);
	const info = JSON.parse(stdout) as { format?: { duration: string }; streams?: {
		codec_type: string; width?: number; height?: number; channels?: number; sample_rate?: string; avg_frame_rate?: string; r_frame_rate?: string; duration?: string;
	}[] };
	const video = info.streams?.find((stream) => stream.codec_type === "video");
	const fpsRatio = video?.avg_frame_rate ?? "";
	const [n, d] = fpsRatio.split("/").map(Number);
	const fps = n / d;
	const duration = Number(info.format?.duration);
	if (!video?.width || !video.height || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(duration) || duration <= 0) {
		throw new Error("The exported file has no usable video timing or dimensions.");
	}
	const audio = info.streams?.find((stream) => stream.codec_type === "audio");
	const channels = audio?.channels ?? 0;
	if (!Number.isSafeInteger(channels) || channels < 0 || channels > 64) throw new Error("Unsupported audio channel count.");
	const sampleRate = Number(audio?.sample_rate ?? 48000);
	if (!Number.isSafeInteger(sampleRate) || sampleRate < 1000 || sampleRate > 384000) throw new Error("Unsupported audio sample rate.");
	const streamDuration = Number(video.duration);
	return { duration, streamDuration: Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : null,
		width: video.width, height: video.height, fps, fpsRatio, channels, sampleRate };
}

async function ffmpeg(args: string[], signal: AbortSignal, root: string) {
	const [exe, ...defaults] = toolsFromEnv().ffmpeg;
	return runProcess(exe, [...defaults, "-hide_banner", "-nostdin", "-threads", "2", "-filter_threads", "2", ...args], signal, root, { lowPriority: true });
}

export async function scanReviewFile(file: string, scratch: string, probe: Probe, signal: AbortSignal, root: string): Promise<FileScan> {
	const video = path.join(scratch, "frames.gray");
	const timing = path.join(scratch, "frames.crc");
	const audio = probe.channels ? path.join(scratch, "audio.f32") : undefined;
	let decodeError: string | undefined;
	let logs: string;
	try {
		const result = await ffmpeg(["-loglevel", "info", "-nostats", "-xerror", ...safeInput, "-i", file,
			...grayOutputs(video, timing),
			...(audio ? ["-map", "0:a:0", "-vn", "-af", "ebur128=peak=true:framelog=verbose,aresample=async=1:first_pts=0", "-f", "f32le", audio] : []),
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
	const stamps = await readStamps(timing, signal).catch((error: NodeJS.ErrnoException) => {
		if (decodeError && error.code === "ENOENT") return [];
		throw error;
	});
	const cadence = frameCadence(stamps, probe.fps);
	const videoStart = stamps[0]?.at ?? 0;
	const lastAt = stamps.at(-1)?.at;
	const probedEnd = probe.streamDuration === null ? null : probe.streamDuration + videoStart;
	if (!decodeError && lastAt !== undefined && probedEnd !== null && probedEnd > lastAt && probedEnd <= lastAt + 1.1 / cadence.fps) {
		cadence.videoDuration = probe.streamDuration!;
	}
	const videoEnd = videoStart + cadence.videoDuration;
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
				const from = stamps[frames]?.at ?? frames / cadence.fps;
				const to = stamps[++frames]?.at ?? videoEnd;
				let count = 0;
				for (const pixel of current) if (pixel <= 16) count++;
				const fraction = count / frameBytes;
				const delta = previous ? meanDelta(previous, current) : Infinity;
				if (fraction >= L.blackFraction) dark = { from: dark?.from ?? from, to, value: Math.min(dark?.value ?? 1, fraction) };
				else { flush(dark, black, 0); dark = undefined; }
				if (delta <= L.freezeMeanDelta && fraction < L.blackFraction) {
					still = { from: still?.from ?? stamps[frames - 2]?.at ?? from, to, value: Math.max(still?.value ?? 0, delta) };
				} else { flush(still, frozen, L.freezeSeconds); still = undefined; }
				(previous ??= Buffer.alloc(frameBytes)).set(current);
			}
			if (bytesRead < bytes.length) break;
		}
		flush(dark, black, 0); flush(still, frozen, L.freezeSeconds);
	} finally { await handle.close(); }
	return { probe, frames, video, audio, decodeError, black, frozen, stamps, videoEnd, ...cadence,
		loudness: Number.isFinite(i) ? i : null, truePeak: Number.isFinite(p) ? p : null };
}

export async function sourceFrames(file: string, times: number[], output: string, signal: AbortSignal, safeRoot: string, still = false) {
	const seek = Math.max(0, times[0] - 0.3);
	const timing = output + ".crc";
	const end = Math.max(0.1, times.at(-1)! - seek + 0.15);
	const formats = still ? [...safeInput.slice(0, -1), safeInput.at(-1) + ",image2,png_pipe,jpeg_pipe,webp_pipe"] : safeInput;
	await ffmpeg(["-loglevel", "error", "-y", ...formats, "-ss", String(seek), "-t", String(end), "-i", file,
		...grayOutputs(output, timing)], signal, safeRoot);
	const data = await fs.readFile(output);
	const stamps = await readStamps(timing, signal);
	if (!stamps.length || (!still && times.some((time) => time - seek > stamps.at(-1)!.at + stamps.at(-1)!.duration + 0.001))) return [];
	return times.map((time) => {
		const index = frameAt(stamps, time - seek);
		return data.subarray(index * frameBytes, (index + 1) * frameBytes);
	});
}

export async function sourcePeak(file: string, from: number, to: number, signal: AbortSignal, root: string) {
	const { stderr } = await ffmpeg(["-loglevel", "info", "-nostats", ...safeInput, "-ss", String(Math.max(0, from)),
		"-t", String(to - from), "-i", file, "-map", "0:a:0", "-vn", "-af", "volumedetect", "-f", "null", "-"], signal, root);
	return Number(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr)?.[1] ?? -Infinity);
}

export async function inspectAudio(scan: FileScan, cuts: { at: number; elementIds: string[] }[], signal: AbortSignal, silent: Interval[] = []) {
	const findings: ReviewFinding[] = [];
	if (!scan.audio) return findings;
	const { duration, channels, sampleRate: rate } = scan.probe;
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
		let quietFrom: number | undefined;
		const blockSize = Math.round(rate / 100);
		const batchSize = blockSize * 100;
		for (let base = 0; base < total; base += batchSize) {
			signal.throwIfAborted();
			const count = Math.min(batchSize, total - base);
			const pcm = await read(base, count);
			for (let index = 0; index < count; index += blockSize) {
				let peak = 0;
				for (let i = index * channels, end = Math.min(pcm.length, (index + blockSize) * channels); i < end; i++) peak = Math.max(peak, Math.abs(pcm[i]));
				const at = (base + index) / rate;
				if (peak < 0.001) quietFrom ??= at;
				else if (quietFrom !== undefined) {
					if (at - quietFrom >= 1 - 1e-8) silent.push({ from: quietFrom, to: at, value: -60 });
					quietFrom = undefined;
				}
			}
		}
		if (quietFrom !== undefined && total / rate - quietFrom >= 1 - 1e-8) silent.push({ from: quietFrom, to: total / rate, value: -60 });
		for (const trailing of [false, true]) {
			let seconds = 0;
			const block = blockSize;
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
