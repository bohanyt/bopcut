import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { transcriptCacheParts } from "@/agent/inside";
import { atomicWrite } from "@/services/storage/server/files";
import { Cancelled, checkCancelled, sharedJob } from "./jobs";
import { assertPublicUrl } from "./net";
import { withToolScratch } from "./process";
import { defaultRunner, runTool, toolsFromEnv, ytDlpJobArgs, type Probe, type Runner } from "./server";
import { RetrievalError } from "./server-errors";
import { isHttpUrl } from "./time";
import { parseCaptions, type Cue, type Span } from "./transcript-cues";

export type TranscriptRequest = { url: string; language?: string; range?: Span; refresh?: boolean };
type Origin = "creator" | "auto";
type Transcript = {
	source: { id: string; pageUrl: string; title?: string; duration?: number };
	language: string; origin: Origin; coverage: Span[]; cues: Cue[]; warnings: string[];
};
type Saved = { file: string; transcript: Transcript; revision?: string | number };
type Format = { ext: "json3" | "vtt"; url?: string; data?: string; last_modified?: string | number; revision?: string | number };
type Metadata = Probe & {
	live_status?: string; original_language?: string; language?: string; http_headers?: Record<string, string>;
	subtitles?: Record<string, Format[]>; automatic_captions?: Record<string, Format[]>;
};
type Track = { origin: Origin; key: string; language: string; format: Format };
type Deps = {
	workspace: string; filesRoot?: string; runner?: Runner; signal?: AbortSignal;
	env?: Record<string, string | undefined>; progress?: (stage: string) => void;
};

export const captionLanguage = /^[a-z\d][a-z\d_-]{0,63}$/i;
const unavailable = "captions unavailable. Try another --lang or use manual ranges; speech-to-text needs a configured command (support is planned).";
const once = sharedJob<{ transcript: Transcript; cached: boolean }>();
const trackJob = sharedJob<{ saved: Saved; cached: boolean } | undefined>();

function youtubeAlias(url: URL) {
	const [, prefix, segment] = url.pathname.split("/");
	const id = url.hostname === "youtu.be" ? prefix
		: /^(?:(?:www|m|music)\.)?youtube\.com$/.test(url.hostname)
			? (prefix === "watch" ? url.searchParams.get("v") : /^(shorts|live|embed)$/.test(prefix) ? segment : null)
			: null;
	return id && /^[\w-]{11}$/.test(id) ? "youtube:" + id : url.href;
}

const aliasFile = (url: string, language?: string) => "alias-" + createHash("sha256")
	.update(JSON.stringify([youtubeAlias(new URL(url)), language?.toLowerCase() ?? null])).digest("hex") + ".json";

async function stat(file: string) {
	return fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

async function cacheDir(workspace: string) {
	await fs.mkdir(workspace, { recursive: true });
	let dir = await fs.realpath(workspace);
	for (const part of [...transcriptCacheParts, "v1"]) {
		dir = path.join(dir, part);
		await fs.mkdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
		if (!(await fs.lstat(dir)).isDirectory()) throw new RetrievalError("Transcript cache path contains a link or is not a directory. Use a regular cache folder.");
	}
	return dir;
}

async function regularFile(file: string) {
	const info = await stat(file);
	if (info && !info.isFile()) throw new RetrievalError("Transcript cache file is a link or is not a regular file. Move it aside and retry.");
	return info;
}

async function readCache<T>(dir: string, name: string): Promise<T | undefined> {
	const file = path.join(dir, name);
	if (!(await regularFile(file))) return;
	try { return JSON.parse(await fs.readFile(file, "utf8")); }
	catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function readTrack(dir: string, file: unknown) {
	if (typeof file !== "string" || !/^[\w%~-]+\.[\w-]+\.(creator|auto)\.json$/.test(file)) return;
	const entry = await readCache<Saved>(dir, file);
	if (entry?.file === file && Array.isArray(entry.transcript?.cues) && Array.isArray(entry.transcript.coverage)) return entry;
}

function httpLink(url: unknown): url is string {
	return isHttpUrl(url) && !new URL(url).username && !new URL(url).password;
}

function chooseTracks(info: Metadata, language?: string) {
	const original = (info.original_language ?? info.language ??
		Object.keys(info.automatic_captions ?? {}).find((key) => key.endsWith("-orig"))?.slice(0, -5))?.toLowerCase();
	const tracks = (["creator", "auto"] as const).flatMap((origin) =>
		Object.entries((origin === "creator" ? info.subtitles : info.automatic_captions) ?? {}).flatMap(([key, formats]) => {
			if (!captionLanguage.test(key) || !Array.isArray(formats)) return [];
			return ["json3", "vtt"].flatMap((ext) => formats.filter((item) => item?.ext === ext &&
				(typeof item.data === "string" || httpLink(item.url))).slice(-1))
				.map((format) => ({ key, language: origin === "auto" ? key.replace(/-orig$/, "") : key, origin, format }));
		}));
	const preferred = language?.toLowerCase() ?? original;
	const rank = (track: Track) => (track.language.toLowerCase() === preferred ? 0 : 4) +
		(track.origin === "creator" ? 0 : track.key.endsWith("-orig") ? 1 : 2);
	return tracks.filter((track) => !language || track.language.toLowerCase() === preferred || track.key.toLowerCase() === preferred)
		.sort((a, b) => rank(a) - rank(b));
}

const namePart = (value: string) => encodeURIComponent(value).replace(/[.!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16));

function readCaptionTrack(
	info: Metadata, track: Track, duration: number | undefined, deps: Deps, signal: AbortSignal,
	run: (args: string[], signal: AbortSignal) => Promise<string>,
) {
	const { format, key, origin } = track;
	return withToolScratch(signal, deps.filesRoot ?? deps.workspace, async (scratch, activeSignal) => {
		const infoFile = path.join(scratch, "track.json");
		// Keep only the selected caption. A failed info-file load cannot retry the video page.
		await fs.writeFile(infoFile, JSON.stringify({ id: info.id, title: info.title ?? info.id, ext: "mp4",
			http_headers: info.http_headers, [origin === "creator" ? "subtitles" : "automatic_captions"]: { [key]: [format] } }));
		const template = path.join(scratch, "captions.%(ext)s");
		const flags = [origin === "creator" ? "--write-subs" : "--write-auto-subs", "--load-info-json", infoFile,
			"--sub-langs", "all", "--sub-format", format.ext, "--no-simulate", "-o", template, "-o", "subtitle:" + template];
		try {
			if (format.url) await assertPublicUrl(format.url, deps.env, undefined, activeSignal);
			await run(flags, activeSignal);
			const file = path.join(scratch, `captions.${key}.${format.ext}`);
			if ((await fs.stat(file)).size > 32 * 1024 * 1024) return;
			return parseCaptions(await fs.readFile(file, "utf8"), format.ext, origin === "auto", duration);
		} catch (error) {
			checkCancelled(activeSignal, "captions");
			if (error instanceof Cancelled) throw error;
		}
	});
}

export async function getTranscript(request: TranscriptRequest, deps: Deps) {
	const { url, language, range, refresh } = request;
	if (!httpLink(url)) throw new RetrievalError("Pass an http(s) video link without credentials.");
	if (language !== undefined && !captionLanguage.test(language)) throw new RetrievalError("Pass a caption language code to --lang.");
	if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start)) {
		throw new RetrievalError("Pass --range START-END with increasing source times.");
	}
	checkCancelled(deps.signal, "transcript");
	const dir = await cacheDir(deps.workspace);
	const alias = aliasFile(url, language);
	const result = await once(path.join(dir, alias) + Boolean(refresh), deps.signal, async (signal) => {
		if (!refresh) {
			const file = await readCache<string>(dir, alias);
			const cached = await readTrack(dir, file);
			if (cached) {
				deps.progress?.("reading cached transcript");
				return { transcript: cached.transcript, cached: true };
			}
		}
		await assertPublicUrl(url, deps.env, undefined, signal);
		const { ytdlp, cookiesFromBrowser } = toolsFromEnv(deps.env);
		const filesRoot = deps.filesRoot ?? deps.workspace;
		const base = [
			...ytDlpJobArgs(), "--skip-download", "--no-playlist", "--playlist-items", "1", "--ignore-no-formats-error",
			"--no-progress", "--no-write-comments", "--downloader", "native",
			...(cookiesFromBrowser ? ["--cookies-from-browser", cookiesFromBrowser] : []),
		];
		const run = (args: string[], activeSignal: AbortSignal) => runTool(deps.runner ?? defaultRunner, ytdlp, [...base, ...args], "yt-dlp", activeSignal, filesRoot);
		deps.progress?.("reading caption tracks");
		let info: Metadata;
		try {
			info = JSON.parse(await run(["--simulate", "--dump-single-json", "--write-subs", "--write-auto-subs", "--", url], signal));
		} catch (error) {
			if (error instanceof Cancelled) throw error;
			// Tool diagnostics can include signed links or request headers.
			if (error instanceof RetrievalError && error.message.startsWith("yt-dlp was not found.")) throw error;
			throw new RetrievalError("Could not read caption tracks. Check the video link and yt-dlp configuration, then retry.");
		}
		if (info?.is_live || info?.live_status === "is_live") throw new RetrievalError("This live stream is still running. Retry when the replay is available.");
		if (typeof info?.id !== "string" || !info.id || typeof info.extractor_key !== "string" || !info.extractor_key) {
			throw new RetrievalError("Could not identify this video. Pass a single video link and retry.");
		}
		const source = {
			id: namePart(info.extractor_key.toLowerCase()) + "-" + namePart(info.id),
			pageUrl: httpLink(info.webpage_url) ? info.webpage_url : url, title: info.title,
			duration: typeof info.duration === "number" && Number.isFinite(info.duration) && info.duration > 0 ? info.duration : undefined,
		};
		const preferred = chooseTracks(info)[0];
		for (const track of chooseTracks(info, language)) {
			// Escape uppercase so case-sensitive source IDs stay distinct on Windows.
			const file = `${source.id}.${track.key}`.replace(/[A-Z]/g, (c) => "%" + c.charCodeAt(0).toString(16))
				+ `.${track.origin}.json`;
			const revision = track.format.revision ?? track.format.last_modified;
			const aliases = new Set([alias, aliasFile(source.pageUrl, language)]);
			if (!language) {
				aliases.add(aliasFile(url, track.language));
				aliases.add(aliasFile(source.pageUrl, track.language));
			}
			if (!language || (preferred?.key === track.key && preferred.origin === track.origin)) {
				aliases.add(aliasFile(url));
				aliases.add(aliasFile(source.pageUrl));
			}
			await Promise.all([...aliases].map((name) => regularFile(path.join(dir, name))));
			const entry = await trackJob(path.join(dir, file), signal, async (activeSignal) => {
				const existing = await readTrack(dir, file);
				if (!refresh && existing && existing.revision === revision && existing.transcript.source.duration === source.duration) {
					return { saved: existing, cached: true };
				}
				deps.progress?.("reading " + track.origin + " captions");
				const parsed = await readCaptionTrack(info, track, source.duration, deps, activeSignal, run);
				if (!parsed?.cues.length) return;
				const end = source.duration ?? parsed.cues.reduce((last, cue) => Math.max(last, cue.end), 0);
				const saved = { file, revision, transcript: { source, language: track.language, origin: track.origin,
					coverage: [{ start: 0, end }], ...parsed } };
				await atomicWrite(path.join(dir, file), JSON.stringify(saved), activeSignal);
				return { saved, cached: false };
			});
			if (!entry) continue;
			for (const name of aliases) {
				await atomicWrite(path.join(dir, name), JSON.stringify(file), signal);
			}
			return { transcript: entry.saved.transcript, cached: entry.cached };
		}
		throw new RetrievalError(unavailable);
	});
	return {
		...result.transcript, cached: result.cached,
		cues: range ? result.transcript.cues.filter((cue) => cue.start < range.end && cue.end > range.start) : result.transcript.cues,
	};
}
