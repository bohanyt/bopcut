import { promises as fs } from "node:fs";
import path from "node:path";
import { Cancelled, checkCancelled } from "./jobs";
import { assertPublicUrl } from "./net";
import { withToolScratch } from "./process";
import { defaultRunner, runTool, toolsFromEnv, ytDlpJobArgs, type Probe, type Runner } from "./server";
import { RetrievalError, UnresolvedHostError } from "./server-errors";
import { isHttpUrl } from "./time";
import { parseCaptions, type Span } from "./transcript-cues";

export type TranscriptRequest = { url: string; language?: string; range?: Span };
type Origin = "creator" | "auto";
type Format = { ext: "json3" | "vtt"; url?: string; data?: string };
type Metadata = Probe & {
	live_status?: string; original_language?: string; language?: string; http_headers?: Record<string, string>;
	subtitles?: Record<string, Format[]>; automatic_captions?: Record<string, Format[]>;
};
type Track = { origin: Origin; key: string; language: string; format: Format };
type Deps = {
	workspace: string; filesRoot?: string; runner?: Runner; signal?: AbortSignal;
	env?: Record<string, string | undefined>; progress?: (stage: string) => void;
	resolve?: Parameters<typeof assertPublicUrl>[2];
};

export const captionLanguage = /^[a-z\d][a-z\d_-]{0,63}$/i;
const unavailable = "captions unavailable. Try another --lang or use manual ranges; speech-to-text needs a configured command (support is planned).";

function httpLink(url: unknown): url is string {
	return isHttpUrl(url) && !new URL(url).username && !new URL(url).password;
}

function chooseTracks(info: Metadata, language?: string) {
	// An explicit original-track marker says more than the generic language fields.
	const original = (Object.keys(info.automatic_captions ?? {}).find((key) => key.endsWith("-orig"))?.slice(0, -5) ??
		info.original_language ?? info.language)?.toLowerCase();
	const tracks = (["creator", "auto"] as const).flatMap((origin) =>
		Object.entries((origin === "creator" ? info.subtitles : info.automatic_captions) ?? {}).flatMap(([key, formats]) => {
			if (!captionLanguage.test(key) || !Array.isArray(formats)) return [];
			const extensions = origin === "auto" && formats.some((item) => item?.ext === "json3") ? ["json3"] : ["json3", "vtt"];
			return extensions.flatMap((ext) => formats.filter((item) => item?.ext === ext &&
				(typeof item.data === "string" || httpLink(item.url))).slice(-1))
				.map((format) => ({ key, language: origin === "auto" ? key.replace(/-orig$/, "") : key, origin, format }));
		}));
	const preferred = language?.toLowerCase() ?? original;
	const rank = (track: Track) => (track.language.toLowerCase() === preferred ? 0 : 4) +
		(track.origin === "creator" ? 0 : track.key.endsWith("-orig") ? 1 : 2);
	return tracks.filter((track) => !language || track.language.toLowerCase() === preferred || track.key.toLowerCase() === preferred)
		.sort((a, b) => rank(a) - rank(b));
}

function readCaptionTrack(
	info: Metadata, track: Track, duration: number | undefined, deps: Deps, signal: AbortSignal | undefined,
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
			// A caption host may resolve only through yt-dlp's configured proxy. Private addresses stay refused.
			if (format.url) await assertPublicUrl(format.url, deps.env, deps.resolve, activeSignal).catch((error: unknown) => {
				if (!(error instanceof UnresolvedHostError)) throw error;
			});
			await run(flags, activeSignal);
			const file = path.join(scratch, `captions.${key}.${format.ext}`);
			if ((await fs.stat(file)).size > 32 * 1024 * 1024) return;
			return parseCaptions(await fs.readFile(file, "utf8"), format.ext, origin === "auto", duration);
		} catch (error) {
			checkCancelled(activeSignal, "captions");
			if (error instanceof Cancelled) throw error;
		}
	}, deps.workspace);
}

export async function getTranscript(request: TranscriptRequest, deps: Deps) {
	const { url, language, range } = request;
	if (!httpLink(url)) throw new RetrievalError("Pass an http(s) video link without credentials.");
	if (language !== undefined && !captionLanguage.test(language)) throw new RetrievalError("Pass a caption language code to --lang.");
	if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start)) {
		throw new RetrievalError("Pass --range START-END with increasing source times.");
	}
	checkCancelled(deps.signal, "transcript");
	const signal = deps.signal;
	await assertPublicUrl(url, deps.env, deps.resolve, signal);
	const { ytdlp, cookiesFromBrowser } = toolsFromEnv(deps.env);
	const filesRoot = deps.filesRoot ?? deps.workspace;
	const base = [
		...ytDlpJobArgs(), "--skip-download", "--no-playlist", "--playlist-items", "1", "--ignore-no-formats-error",
		"--no-progress", "--no-write-comments", "--downloader", "native",
		...(cookiesFromBrowser ? ["--cookies-from-browser", cookiesFromBrowser] : []),
	];
	const run = (args: string[], activeSignal: AbortSignal | undefined) => runTool(deps.runner ?? defaultRunner, ytdlp, [...base, ...args], "yt-dlp", activeSignal, filesRoot, deps.workspace);
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
		id: info.extractor_key.toLowerCase() + "-" + info.id,
		pageUrl: httpLink(info.webpage_url) ? info.webpage_url : url, title: info.title,
		duration: typeof info.duration === "number" && Number.isFinite(info.duration) && info.duration > 0 ? info.duration : undefined,
	};
	const warnings: string[] = [];
	for (const track of chooseTracks(info, language)) {
		deps.progress?.("reading " + track.origin + " captions");
		const parsed = await readCaptionTrack(info, track, source.duration, deps, signal, run);
		if (!parsed) continue;
		warnings.push(...parsed.warnings);
		if (!parsed.cues.length) continue;
		const end = source.duration ?? parsed.cues.reduce((last, cue) => Math.max(last, cue.end), 0);
		const cues = range ? parsed.cues.filter((cue) => cue.start < range.end &&
			(cue.end > range.start || (cue.start === cue.end && cue.start === range.start))) : parsed.cues;
		return { source, language: track.language, origin: track.origin, coverage: [{ start: 0, end }], cues, warnings };
	}
	throw new RetrievalError([unavailable, ...warnings].join(" "));
}
