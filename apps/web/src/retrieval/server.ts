// Server-side media retrieval: fetch only a section of an online video (yt-dlp downloads just that range
// Node only: used by the agent API route and the retrieve CLI.
import { runProcess, runYtDlpProcess } from "./process";
import { Cancelled, cacheTargets, checkCancelled, publishMedia, reusePublished, sharedJob, withScratch } from "./jobs";
import { existsSync } from "node:fs";
import { RetrievalError } from "./server-errors";
import { assertPublicUrl, fetchPublic, readCapped } from "./net";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
	type FrameRequest,
	type SectionRequest,
	formatTime,
	isHttpUrl,
	linkAt,
	normalizeFrameRequest,
	normalizeSectionRequest,
} from "./time";

export { RetrievalError };

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
/** A setting that names an existing file is one executable path, even with spaces; otherwise a command line. */
export function commandFromSetting(value: string | undefined, fallback: string, fileExists: (p: string) => boolean = existsSync): string[] {
	const raw = value?.trim();
	if (!raw) return [fallback];
	const unquoted = raw.replace(/^(['"])(.*)\1$/, "$2");
	return fileExists(unquoted) ? [unquoted] : splitCommand(raw);
}

export function toolsFromEnv(env: Record<string, string | undefined> = process.env, fileExists: (p: string) => boolean = existsSync): RetrievalTools {
	return {
		ytdlp: commandFromSetting(env.BOPENCUT_YTDLP, "yt-dlp", fileExists),
		ffmpeg: commandFromSetting(env.BOPENCUT_FFMPEG, "ffmpeg", fileExists),
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

/** `filesRoot` is the caller's files root: private tool files must never be written inside it. */
export type Runner = (command: string, args: string[], signal?: AbortSignal, filesRoot?: string) => Promise<{ stdout: string; stderr: string }>;
export const defaultRunner: Runner = runProcess;

/** Keep the user's extractor settings while overriding side effects and job paths. */
export function ytDlpJobArgs(scratch?: string) {
	return [
		"--no-cache-dir", "--no-download-archive", "--no-exec", "--no-exec-before-download",
		"--no-write-description", "--no-write-info-json", "--no-write-subs", "--no-write-auto-subs",
		"--no-write-thumbnail", "--no-split-chapters", "--no-check-formats",
		...(scratch ? ["-P", "temp:" + scratch] : []),
	];
}

export async function runTool(runner: Runner, tool: string[], args: string[], label: string, signal?: AbortSignal, filesRoot?: string, workspace?: string): Promise<string> {
	return (await runToolOutput(runner, tool, args, label, signal, filesRoot, workspace)).stdout;
}

/** Runs a configured tool; missing tools and failures become a RetrievalError with a short message. */
export async function runToolOutput(runner: Runner, tool: string[], args: string[], label: string, signal?: AbortSignal, filesRoot?: string, workspace?: string): Promise<{ stdout: string; stderr: string }> {
	try {
		checkCancelled(signal, label);
		const run = label === "yt-dlp" && runner === defaultRunner ? runYtDlpProcess : runner;
		const output = await run(tool[0], [...tool.slice(1), ...args], signal, filesRoot, workspace);
		checkCancelled(signal, label);
		return output;
	} catch (error) {
		if (error instanceof Cancelled) throw new Cancelled(label);
		checkCancelled(signal, label);
		if (error instanceof RetrievalError) throw error;
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
	/** The verified media type of a file fetched from a web link (its bytes, not the server's header). */
	mime?: string;
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
	const args = ["--no-playlist", "--playlist-items", "1", "--no-warnings", "--no-progress", "--no-simulate", "-O", "%()j", "--force-overwrites", "--match-filter", "!is_live"];
	if (tools.cookiesFromBrowser) args.push("--cookies-from-browser", tools.cookiesFromBrowser);
	args.push(...ffmpegLocation(tools), "-f", formatSelector(height, audioOnly), "--download-sections", `*${start.toFixed(3)}-${end.toFixed(3)}`);
	if (audioOnly) {
		args.push("-x", "--audio-format", "m4a");
	} else {
		// -f mp4: H.264 + AAC always land in an MP4 container, also when the source was a single WebM stream.
		const encode = [...encoderArgs(tools.videoEncoder), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-f", "mp4"].join(" ");
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

/** A cached result, or undefined when the media or its sidecar is missing or unreadable (a cache miss). */
async function readCached(media: string, meta: string): Promise<RetrievedFile | undefined> {
	if (!(await exists(media))) return undefined;
	try {
		return { ...(JSON.parse(await fs.readFile(meta, "utf8")) as Omit<RetrievedFile, "cached">), cached: true };
	} catch {
		return undefined;
	}
}

const once = sharedJob<RetrievedFile>();

export type RetrievalDeps = {
	filesRoot: string; tools?: RetrievalTools; runner?: Runner; env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch; signal?: AbortSignal;
};

async function download(
	request: SectionRequest, dir: string, signal: AbortSignal, deps: RetrievalDeps,
): Promise<{ file: string; info: Probe }> {
	const { start, end, url, audioOnly } = request;
	const { tools = toolsFromEnv(deps.env), runner = defaultRunner } = deps;
	const stem = "section";
	const output = path.join(dir, stem + ".%(ext)s");
	const args = downloadArgs({ url, start, end, height: request.height ?? tools.defaultHeight, audioOnly, tools, output });
	const info = parseInfo(await runTool(runner, tools.ytdlp, [...ytDlpJobArgs(dir), ...args], "yt-dlp", signal, deps.filesRoot));
	if (info?.is_live) throw new RetrievalError("this link is a live stream that is still running; use it once the replay is available");
	const files = await fs.readdir(dir);
	const expected = stem + (audioOnly ? ".m4a" : ".mp4");
	const produced = files.includes(expected) ? expected : files.find((file) =>
		file.startsWith(stem + ".") && !/\.f\d+\.|\.(part|ytdl)$|\.temp/.test(file.slice(stem.length)));
	if (!info || !produced) throw new RetrievalError("nothing was downloaded (a live stream that is still running, or an unsupported link)");
	return { file: path.join(dir, produced), info };
}

function cachedDownload(
	deps: RetrievalDeps, key: string, directory: string, extension: string,
	work: (scratch: string, signal: AbortSignal) => Promise<{ file: string; result: Omit<RetrievedFile, "path" | "cached"> }>,
): Promise<RetrievedFile> {
	const root = path.resolve(deps.filesRoot);
	const legacyMeta = path.join(root, directory, key + ".json");
	return once(root + "|" + key, deps.signal, async (signal) => {
		const { meta, sidecars } = await cacheTargets(legacyMeta);
		const mediaName = key + extension;
		const media = path.join(path.dirname(meta), mediaName);
		const lookup = async () => {
			for (const sidecar of sidecars) {
				const found = await readCached(path.join(path.dirname(sidecar), mediaName), sidecar);
				if (found) return found;
			}
		};
		const cached = await lookup();
		if (cached) return cached;
		return withScratch(path.join(root, directory), signal, async (scratch) => {
			const { file, result } = await work(scratch, signal);
			const saved = { ...result, path: toPosix(path.relative(root, media)) };
			if (!(await publishMedia(file, media, signal, { file: meta, value: saved }))) return reusePublished(lookup);
			return { ...saved, cached: false };
		});
	});
}

/** Fetch [start, end) and cache it by link, range, height and audio mode. */
export async function fetchSection(request: SectionRequest, deps: RetrievalDeps): Promise<RetrievedFile> {
	const tools = deps.tools ?? toolsFromEnv(deps.env);
	const validated = normalizeSectionRequest(request, tools.maxSectionSeconds);
	if (!validated.ok) throw new RetrievalError(validated.error);
	const { url, start, end, audioOnly } = validated.value;
	const height = request.height ?? tools.defaultHeight;
	const key = cacheKey(["section", url, start, end, height, Boolean(audioOnly)]);
	const ext = audioOnly ? ".m4a" : ".mp4";
	return cachedDownload(deps, key, "retrieved", ext, async (scratch, signal) => {
		const { file, info } = await download({ ...validated.value, height }, scratch, signal, { ...deps, tools });
		return { file, result: {
			type: audioOnly ? "audio" : "video",
			name: (info.title ?? "clip") + " " + formatTime(start) + "-" + formatTime(end),
			source: sourceInfo(info, url, start, end),
		} };
	});
}

/** Grab the first frame of a one-second window and keep only its JPEG. */
export async function fetchFrame(request: FrameRequest, deps: RetrievalDeps): Promise<RetrievedFile> {
	const { url, time, width = 960 } = request;
	const key = cacheKey(["frame", url, time, width]);
	return cachedDownload(deps, key, "retrieved/frames", ".jpg", async (scratch, signal) => {
		const { file: video, info } = await download({ url, start: time, end: time + 1, height: 720 }, scratch, signal, deps);
		const file = path.join(scratch, "still.jpg");
		await runTool(deps.runner ?? defaultRunner, (deps.tools ?? toolsFromEnv(deps.env)).ffmpeg,
			["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-frames:v", "1", "-vf", "scale=" + width + ":-2", "-q:v", "3", file], "ffmpeg", signal, deps.filesRoot);
		return { file, result: { type: "image", name: (info.title ?? "frame") + " " + formatTime(time), source: sourceInfo(info, url, time, time) } };
	});
}

/** A link to a playlist page rather than one video (a video link with `list=` is fine: one entry is taken). */
export function isPlaylistOnly(url: string): boolean {
	try {
		const u = new URL(url);
		return /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/playlist";
	} catch {
		return false;
	}
}

/** A supported media file recognized from its first bytes (the server's Content-Type is not trusted). */
export type SniffedMedia = { ext: string; type: "image" | "video" | "audio"; mime: string };

const ascii = (bytes: Uint8Array, from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

/** The media format of a file from its first bytes, "svg" for SVG documents, or null when unsupported. */
export function sniffMedia(bytes: Uint8Array): SniffedMedia | "svg" | null {
	const b = bytes;
	if (b.length < 4) return null;
	if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return { ext: ".png", type: "image", mime: "image/png" };
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: ".jpg", type: "image", mime: "image/jpeg" };
	if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { ext: ".gif", type: "image", mime: "image/gif" };
	if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { ext: ".webp", type: "image", mime: "image/webp" };
	if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") return { ext: ".wav", type: "audio", mime: "audio/wav" };
	if (ascii(b, 4, 8) === "ftyp") {
		const brands = [ascii(b, 8, 12), ...Array.from({ length: 6 }, (_, i) => ascii(b, 16 + i * 4, 20 + i * 4))];
		if (brands.some((brand) => brand === "avif" || brand === "avis")) return { ext: ".avif", type: "image", mime: "image/avif" };
		if (brands[0] === "M4A " || brands[0] === "M4B ") return { ext: ".m4a", type: "audio", mime: "audio/mp4" };
		if (brands[0] === "qt  ") return { ext: ".mov", type: "video", mime: "video/quicktime" };
		return { ext: ".mp4", type: "video", mime: "video/mp4" };
	}
	if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: ".webm", type: "video", mime: "video/webm" };
	if (ascii(b, 0, 4) === "OggS") return { ext: ".ogg", type: "audio", mime: "audio/ogg" };
	if (ascii(b, 0, 4) === "fLaC") return { ext: ".flac", type: "audio", mime: "audio/flac" };
	if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return { ext: ".mp3", type: "audio", mime: "audio/mpeg" };
	const head = new TextDecoder().decode(b.subarray(0, 512)).replace(/^\uFEFF/, "").trimStart().toLowerCase();
	if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
	return null;
}

const MAX_WEB_FILE_BYTES = 100 * 1024 * 1024;
const WEB_FETCH_TIMEOUT_MS = 120_000;

/**
 * A media file from a web link (an image dragged from a web page, a pasted image link) into
 * `<filesRoot>/retrieved/web/`, cached by link. Only images, videos and sounds up to 100 MB are kept.
 * Every redirect hop must point at a public address, the body is read with a size cap and a timeout, and
 * the format comes from the file's own bytes. SVG documents are refused (they can carry scripts).
 */
export function fetchWebFile(url: string, deps: RetrievalDeps): Promise<RetrievedFile> {
	const key = cacheKey(["web", url]);
	return once(path.resolve(deps.filesRoot) + "|" + key, deps.signal, (signal) =>
		downloadWebFile(url, key, deps, signal));
}

async function downloadWebFile(url: string, key: string, { filesRoot, fetchImpl = fetch, env }: RetrievalDeps, signal: AbortSignal): Promise<RetrievedFile> {
	const dir = path.join(filesRoot, "retrieved", "web");
	const legacyMeta = path.join(dir, key + ".json");
	const { meta, sidecars } = await cacheTargets(legacyMeta);
	const lookup = async (): Promise<RetrievedFile | undefined> => {
		for (const sidecar of sidecars) {
			try {
				const cached = JSON.parse(await fs.readFile(sidecar, "utf8")) as Omit<RetrievedFile, "cached">;
				if (await exists(path.join(filesRoot, cached.path))) return { ...cached, cached: true };
			} catch {
				// Missing or unreadable sidecar.
			}
		}
	};
	const cached = await lookup();
	if (cached) return cached;
	return withScratch(dir, signal, async (scratch, signal) => {
		let res: Response;
		let bytes: Buffer;
		try {
			res = await fetchPublic(url, {
				fetchImpl,
				env,
				timeoutMs: WEB_FETCH_TIMEOUT_MS,
				signal,
				headers: { "User-Agent": "Mozilla/5.0 (compatible; bopencut)", Accept: "image/*,video/*,audio/*;q=0.9,*/*;q=0.1" },
			});
			if (!res.ok) {
				await res.body?.cancel();
				throw new RetrievalError(`the link answered ${res.status}`);
			}
			bytes = await readCapped(res, MAX_WEB_FILE_BYTES);
		} catch (error) {
			checkCancelled(signal, "web download");
			if (error instanceof RetrievalError) throw error;
			throw new RetrievalError(`could not download the link: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (bytes.length === 0) throw new RetrievalError("the link gave an empty file");
		const kind = sniffMedia(bytes);
		if (kind === "svg") throw new RetrievalError("SVG images are not supported; use a PNG or JPEG of it");
		if (!kind) {
			const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
			throw new RetrievalError(`the link is not a supported image, video or sound (${declared || "unknown type"})`);
		}
		const file = path.join(path.dirname(meta), key + kind.ext);
		const staged = path.join(scratch, "web" + kind.ext);
		await fs.writeFile(staged, bytes, { signal });
		let name = "web media";
		try {
			name = decodeURIComponent(new URL(res.url || url).pathname.split("/").pop() || "").replace(/\.[a-z0-9]{2,5}$/i, "") || name;
		} catch {
			// keep the default name
		}
		const result: Omit<RetrievedFile, "cached"> = {
			path: toPosix(path.relative(filesRoot, file)),
			type: kind.type,
			mime: kind.mime,
			name,
			source: { url, pageUrl: url, link: url, start: 0, end: 0, fetchedAt: new Date().toISOString() },
		};
		if (!(await publishMedia(staged, file, signal, { file: meta, value: result }))) return reusePublished(lookup);
		return { ...result, cached: false };
	});

}

/** Body of POST /api/agent/retrieve: `{kind:"section", url, start, end|duration, height?, audioOnly?}`, `{kind:"frame", url, time, width?}` or `{kind:"file", url}`. */
export async function handleRetrieve(body: unknown, deps: RetrievalDeps): Promise<{ status: number; body: unknown }> {
	const tools = deps.tools ?? toolsFromEnv(deps.env);
	const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	try {
		checkCancelled(deps.signal, "preparation");
		if (input.kind === "section") {
			const request = normalizeSectionRequest(input, tools.maxSectionSeconds);
			if (!request.ok) return { status: 400, body: { error: request.error } };
			if (isPlaylistOnly(request.value.url)) return { status: 400, body: { error: "this is a playlist link; use the link of one video" } };
			await assertPublicUrl(request.value.url, deps.env, undefined, deps.signal);
			return { status: 200, body: await fetchSection(request.value, { ...deps, tools }) };
		}
		if (input.kind === "frame") {
			const request = normalizeFrameRequest(input);
			if (!request.ok) return { status: 400, body: { error: request.error } };
			if (isPlaylistOnly(request.value.url)) return { status: 400, body: { error: "this is a playlist link; use the link of one video" } };
			await assertPublicUrl(request.value.url, deps.env, undefined, deps.signal);
			return { status: 200, body: await fetchFrame(request.value, { ...deps, tools }) };
		}
		if (input.kind === "file") {
			if (!isHttpUrl(input.url)) return { status: 400, body: { error: "url must be an http(s) link" } };
			return { status: 200, body: await fetchWebFile(input.url, deps) };
		}
		return { status: 400, body: { error: 'kind must be "section", "frame" or "file"' } };
	} catch (error) {
		if (error instanceof RetrievalError) return { status: error instanceof Cancelled ? 499 : 502, body: { error: error.message } };
		throw error;
	}
}
