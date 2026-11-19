// Server-side media retrieval: fetch only a section of an online video (yt-dlp downloads just that range
// and re-encodes it with key frames at the cuts), or one frame of it. Never downloads a whole video.
// Node only: used by the agent API route and the retrieve CLI.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
	type FrameRequest,
	type SectionRequest,
	formatTime,
	linkAt,
	normalizeFrameRequest,
	normalizeSectionRequest,
} from "./time";

export type RetrievalTools = {
	ytdlp: string[];
	ffmpeg: string[];
	cookiesFromBrowser?: string;
	videoEncoder: string;
	defaultHeight: number;
	maxSectionSeconds: number;
};

/** Splits a command such as `python -m yt_dlp` or `"C:\\Program Files\\ffmpeg\\ffmpeg.exe"` into argv. */
export function splitCommand(command: string): string[] {
	const parts: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (let m = re.exec(command); m; m = re.exec(command)) parts.push(m[1] ?? m[2] ?? m[3]);
	return parts;
}

function positiveInt(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Tools from the environment:
 * BOPENCUT_YTDLP (default `yt-dlp`), BOPENCUT_FFMPEG (default `ffmpeg`),
 * BOPENCUT_YTDLP_COOKIES_FROM_BROWSER (e.g. `firefox`), BOPENCUT_VIDEO_ENCODER (default `libx264`;
 * e.g. `h264_nvenc`, `h264_qsv`, `h264_amf`, `h264_videotoolbox`), BOPENCUT_RETRIEVE_HEIGHT (default 1080),
 * BOPENCUT_RETRIEVE_MAX_SECONDS (default 1800).
 */
export function toolsFromEnv(env: Record<string, string | undefined> = process.env): RetrievalTools {
	return {
		ytdlp: splitCommand(env.BOPENCUT_YTDLP?.trim() || "yt-dlp"),
		ffmpeg: splitCommand(env.BOPENCUT_FFMPEG?.trim() || "ffmpeg"),
		cookiesFromBrowser: env.BOPENCUT_YTDLP_COOKIES_FROM_BROWSER?.trim() || undefined,
		videoEncoder: env.BOPENCUT_VIDEO_ENCODER?.trim() || "libx264",
		defaultHeight: positiveInt(env.BOPENCUT_RETRIEVE_HEIGHT, 1080),
		maxSectionSeconds: positiveInt(env.BOPENCUT_RETRIEVE_MAX_SECONDS, 1800),
	};
}

/** Encoder arguments: quality-based settings for libx264 and NVENC, a bitrate for other hardware encoders. */
export function encoderArgs(encoder: string): string[] {
	if (encoder === "libx264") return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"];
	if (encoder.endsWith("_nvenc")) return ["-c:v", encoder, "-preset", "p5", "-cq", "21"];
	return ["-c:v", encoder, "-b:v", "12M"];
}

export type Runner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: Runner = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(error, { stderr: String(stderr ?? "") }));
			else resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});

export class RetrievalError extends Error {}

async function runTool(runner: Runner, tool: string[], args: string[], label: string): Promise<string> {
	try {
		return (await runner(tool[0], [...tool.slice(1), ...args])).stdout;
	} catch (error) {
		const e = error as NodeJS.ErrnoException & { stderr?: string };
		if (e.code === "ENOENT") {
			const env = label === "yt-dlp" ? "BOPENCUT_YTDLP (for example `python -m yt_dlp`)" : "BOPENCUT_FFMPEG";
			throw new RetrievalError(`${label} was not found. Install it or set ${env}.`);
		}
		const lines = (e.stderr || e.message || "").trim().split(/\r?\n/).filter((l) => l.trim() && !/^\s*size=/.test(l));
		throw new RetrievalError(`${label} failed: ${lines.slice(-3).join(" ")}`);
	}
}

export type Probe = {
	title?: string;
	uploader?: string;
	channel?: string;
	id?: string;
	extractor_key?: string;
	webpage_url?: string;
	duration?: number;
	is_live?: boolean;
};

export type SourceInfo = {
	url: string;
	pageUrl: string;
	link: string;
	title?: string;
	uploader?: string;
	id?: string;
	extractor?: string;
	start: number;
	end: number;
	fetchedAt: string;
};

export type RetrievedFile = {
	/** Relative to the files root, with forward slashes: use it as a draft/bundle asset `path`. */
	path: string;
	type: "video" | "audio" | "image";
	name: string;
	source: SourceInfo;
	cached: boolean;
};

/** yt-dlp format: H.264 + AAC when available, else the best up to `height`. */
export const formatSelector = (height: number, audioOnly?: boolean) =>
	audioOnly
		? "ba[ext=m4a]/ba/b"
		: `bv*[height<=${height}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b`;

/** `--ffmpeg-location` for yt-dlp when ffmpeg is configured as a path rather than a command on PATH. */
function ffmpegLocation(tools: RetrievalTools): string[] {
	const [command, ...rest] = tools.ffmpeg;
	return rest.length === 0 && /[\\/]/.test(command) ? ["--ffmpeg-location", command] : [];
}

/**
 * yt-dlp arguments that download only [start, end) and print the info JSON. Video is re-encoded with key
 * frames at the cuts, so the section starts exactly at `start`. Running live streams are skipped.
 */
export function downloadArgs({ url, start, end, height, audioOnly, tools, output }: { url: string; start: number; end: number; height: number; audioOnly?: boolean; tools: RetrievalTools; output: string }): string[] {
	const args = ["--no-playlist", "--no-warnings", "--no-progress", "--no-simulate", "-O", "%()j", "--force-overwrites", "--match-filter", "!is_live"];
	if (tools.cookiesFromBrowser) args.push("--cookies-from-browser", tools.cookiesFromBrowser);
	args.push(...ffmpegLocation(tools), "-f", formatSelector(height, audioOnly), "--download-sections", `*${start.toFixed(3)}-${end.toFixed(3)}`);
	if (audioOnly) {
		args.push("-x", "--audio-format", "m4a");
	} else {
		const encode = [...encoderArgs(tools.videoEncoder), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k"].join(" ");
		args.push("--force-keyframes-at-cuts", "--downloader-args", `ffmpeg_o:${encode}`, "--merge-output-format", "mp4");
	}
	args.push("-o", output, "--", url);
	return args;
}

function parseInfo(stdout: string): Probe | undefined {
	const line = stdout
		.split(/\r?\n/)
		.reverse()
		.find((l) => l.trim().startsWith("{"));
	if (!line) return undefined;
	try {
		return JSON.parse(line) as Probe;
	} catch {
		return undefined;
	}
}

const cacheKey = (parts: unknown[]) => createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

const toPosix = (rel: string) => rel.split(path.sep).join("/");

function sourceInfo(info: Probe, url: string, start: number, end: number): SourceInfo {
	const pageUrl = info.webpage_url || url;
	return {
		url,
		pageUrl,
		link: linkAt(pageUrl, start),
		title: info.title,
		uploader: info.uploader || info.channel,
		id: info.id,
		extractor: info.extractor_key,
		start,
		end,
		fetchedAt: new Date().toISOString(),
	};
}

async function exists(file: string) {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

const inFlight = new Map<string, Promise<RetrievedFile>>();

/** One fetch per cache key at a time: concurrent identical requests share the same result. */
function once(key: string, work: () => Promise<RetrievedFile>): Promise<RetrievedFile> {
	const running = inFlight.get(key);
	if (running) return running;
	const promise = work().finally(() => inFlight.delete(key));
	inFlight.set(key, promise);
	return promise;
}

export type RetrievalDeps = { filesRoot: string; tools?: RetrievalTools; runner?: Runner };

/** Download a section with yt-dlp into `<dir>/<key>.part.<ext>`; returns the file and the info JSON. */
async function download({ url, start, end, height, audioOnly, dir, key, tools, runner }: { url: string; start: number; end: number; height: number; audioOnly?: boolean; dir: string; key: string; tools: RetrievalTools; runner: Runner }): Promise<{ file: string; info: Probe }> {
	await fs.mkdir(dir, { recursive: true });
	const stem = `${key}.part`;
	const clean = async () => {
		for (const f of await fs.readdir(dir)) if (f.startsWith(stem)) await fs.rm(path.join(dir, f), { force: true });
	};
	await clean();
	try {
		const output = path.join(dir, `${stem}.%(ext)s`);
		const stdout = await runTool(runner, tools.ytdlp, downloadArgs({ url, start, end, height, audioOnly, tools, output }), "yt-dlp");
		const info = parseInfo(stdout);
		if (info?.is_live) throw new RetrievalError("this link is a live stream that is still running; use it once the replay is available");
		const files = await fs.readdir(dir);
		const expected = `${stem}.${audioOnly ? "m4a" : "mp4"}`;
		const produced = files.includes(expected) ? expected : files.find((f) => f.startsWith(`${stem}.`) && !/\.f\d+\.|\.(part|ytdl)$|\.temp/.test(f));
		if (!info || !produced) throw new RetrievalError("nothing was downloaded (a live stream that is still running, or an unsupported link)");
		return { file: path.join(dir, produced), info };
	} catch (error) {
		await clean();
		throw error;
	}
}

/**
 * Fetch [start, end) of an online video into `<filesRoot>/retrieved/`. The result is cached by link,
 * range, height and audioOnly; `<key>.json` next to the media keeps the source (title, page link at
 * the start time) for credits.
 */
export async function fetchSection(request: SectionRequest, { filesRoot, tools = toolsFromEnv(), runner = defaultRunner }: RetrievalDeps): Promise<RetrievedFile> {
	const height = request.height ?? tools.defaultHeight;
	const key = cacheKey(["section", request.url, request.start, request.end, height, Boolean(request.audioOnly)]);
	const dir = path.join(filesRoot, "retrieved");
	const media = path.join(dir, key + (request.audioOnly ? ".m4a" : ".mp4"));
	const meta = path.join(dir, `${key}.json`);
	return once(key, async () => {
		if ((await exists(media)) && (await exists(meta))) {
			return { ...(JSON.parse(await fs.readFile(meta, "utf8")) as Omit<RetrievedFile, "cached">), cached: true };
		}
		const { file, info } = await download({ url: request.url, start: request.start, end: request.end, height, audioOnly: request.audioOnly, dir, key, tools, runner });
		await fs.rename(file, media);
		const result: Omit<RetrievedFile, "cached"> = {
			path: toPosix(path.relative(filesRoot, media)),
			type: request.audioOnly ? "audio" : "video",
			name: `${info.title ?? "clip"} ${formatTime(request.start)}-${formatTime(request.end)}`,
			source: sourceInfo(info, request.url, request.start, request.end),
		};
		await fs.writeFile(meta, JSON.stringify(result, null, 1));
		return { ...result, cached: false };
	});
}

/**
 * One frame of an online video at `time`, as JPEG in `<filesRoot>/retrieved/frames/`, to look before
 * fetching a section. Downloads one second at 720p and keeps only its first frame.
 */
export async function fetchFrame(request: FrameRequest, { filesRoot, tools = toolsFromEnv(), runner = defaultRunner }: RetrievalDeps): Promise<RetrievedFile> {
	const width = request.width ?? 960;
	const key = cacheKey(["frame", request.url, request.time, width]);
	const dir = path.join(filesRoot, "retrieved", "frames");
	const image = path.join(dir, `${key}.jpg`);
	const meta = path.join(dir, `${key}.json`);
	return once(key, async () => {
		if ((await exists(image)) && (await exists(meta))) {
			return { ...(JSON.parse(await fs.readFile(meta, "utf8")) as Omit<RetrievedFile, "cached">), cached: true };
		}
		const { file, info } = await download({ url: request.url, start: request.time, end: request.time + 1, height: 720, dir, key, tools, runner });
		const still = path.join(dir, `${key}.still.jpg`);
		try {
			await runTool(runner, tools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", still], "ffmpeg");
			await fs.rename(still, image);
		} finally {
			await fs.rm(still, { force: true });
			await fs.rm(file, { force: true });
		}
		const result: Omit<RetrievedFile, "cached"> = {
			path: toPosix(path.relative(filesRoot, image)),
			type: "image",
			name: `${info.title ?? "frame"} ${formatTime(request.time)}`,
			source: sourceInfo(info, request.url, request.time, request.time),
		};
		await fs.writeFile(meta, JSON.stringify(result, null, 1));
		return { ...result, cached: false };
	});
}

/** Body of POST /api/agent/retrieve: `{kind:"section", url, start, end|duration, height?, audioOnly?}` or `{kind:"frame", url, time, width?}`. */
export async function handleRetrieve(body: unknown, deps: RetrievalDeps): Promise<{ status: number; body: unknown }> {
	const tools = deps.tools ?? toolsFromEnv();
	const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	try {
		if (input.kind === "section") {
			const request = normalizeSectionRequest(input, tools.maxSectionSeconds);
			if (!request.ok) return { status: 400, body: { error: request.error } };
			return { status: 200, body: await fetchSection(request.value, { ...deps, tools }) };
		}
		if (input.kind === "frame") {
			const request = normalizeFrameRequest(input);
			if (!request.ok) return { status: 400, body: { error: request.error } };
			return { status: 200, body: await fetchFrame(request.value, { ...deps, tools }) };
		}
		return { status: 400, body: { error: 'kind must be "section" or "frame"' } };
	} catch (error) {
		if (error instanceof RetrievalError) return { status: 502, body: { error: error.message } };
		throw error;
	}
}
