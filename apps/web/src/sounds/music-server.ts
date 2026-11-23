// Music for the user and agents: the user's own music folders, plus songs found or linked online and
// fetched (sound only) with yt-dlp. Fetched songs are loudness-normalized so beds start at a known level.
// Node only: used by the agent API route and the music CLI.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { RetrievalError, defaultRunner, runTool, runToolOutput, toolsFromEnv } from "@/retrieval/server";
import { isHttpUrl } from "@/retrieval/time";
import { Cancelled, cacheTargets, checkCancelled, publishMedia, reusePublished, sharedJob, withScratch } from "@/retrieval/jobs";
import { assertPublicUrl } from "@/retrieval/net";
import { MUSIC_SOURCES, type MusicFile, type MusicResult, type MusicSource } from "./music-types";
import { type LibraryKind, type SfxDeps, clearLibraryIndex, getLibrary, searchLibrary, words } from "./sfx-server";

export const MUSIC_LIBRARY: LibraryKind = { folder: "music", envVar: "BOPENCUT_MUSIC_DIRS", previewRoute: "/api/agent/music-file" };

export type MusicDeps = SfxDeps;

function maxSeconds(env: Record<string, string | undefined>): number {
	const n = Number(env.BOPENCUT_MUSIC_MAX_SECONDS);
	return Number.isInteger(n) && n > 0 ? n : 900;
}

type FlatEntry = { id?: string; title?: string; url?: string; webpage_url?: string; duration?: number; channel?: string; uploader?: string; live_status?: string | null };

/** Songs found online for a query (yt-dlp search, metadata only). Long videos and live streams are left out. */
export async function searchOnline(query: string, deps: MusicDeps, limit = 8): Promise<MusicResult[]> {
	const env = deps.env ?? process.env;
	const tools = deps.tools ?? toolsFromEnv(env);
	const args = ["--ignore-config", "--skip-download", "--flat-playlist", "-J", "--no-warnings", "--", `ytsearch${Math.min(20, limit + 4)}:${query.trim()}`];
	const stdout = await runTool(deps.runner ?? defaultRunner, tools.ytdlp, args, "yt-dlp", deps.signal);
	let entries: FlatEntry[] = [];
	try {
		entries = (JSON.parse(stdout) as { entries?: FlatEntry[] }).entries ?? [];
	} catch {
		throw new RetrievalError("yt-dlp returned no search results");
	}
	const limitSeconds = maxSeconds(env);
	return entries
		.filter((e) => (e.webpage_url || e.url) && e.title && (e.duration ?? 0) > 0 && (e.duration ?? 0) <= limitSeconds && !/live/.test(e.live_status ?? ""))
		.slice(0, limit)
		.map((e) => ({
			source: "online" as const,
			ref: (e.webpage_url || e.url) as string,
			name: e.title as string,
			tags: [e.channel || e.uploader].filter((t): t is string => Boolean(t)),
			duration: e.duration,
			pageUrl: (e.webpage_url || e.url) as string,
		}));
}

export async function searchMusic(query: string, sources: readonly MusicSource[], deps: MusicDeps, limit = 20): Promise<{ results: MusicResult[]; errors: { source: MusicSource; error: string }[] }> {
	const results: MusicResult[] = [];
	const errors: { source: MusicSource; error: string }[] = [];
	for (const source of sources) {
		try {
			if (source === "library") results.push(...(await searchLibrary(query, deps, limit, MUSIC_LIBRARY)).map((r) => ({ ...r, source: "library" as const })));
			else results.push(...(await searchOnline(query, deps, Math.min(limit, 8))));
		} catch (error) {
			checkCancelled(deps.signal, "music search");
			errors.push({ source, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { results, errors };
}

async function exists(file: string) {
	try {
		await fs.access(file);
		return true;
	} catch {
		return false;
	}
}

const toPosix = (rel: string) => rel.split(path.sep).join("/");

/** Integrated loudness target for fetched songs (BOPENCUT_MUSIC_LOUDNESS, LUFS; `off` keeps them as fetched). */
function loudnessTarget(env: Record<string, string | undefined>): number | null {
	const raw = (env.BOPENCUT_MUSIC_LOUDNESS ?? "-16").trim().toLowerCase();
	if (raw === "off") return null;
	const n = Number(raw);
	// ffmpeg's loudnorm accepts integrated targets from -70 to -5 LUFS.
	return Number.isFinite(n) && n >= -70 && n <= -5 ? n : -16;
}

const onlineJob = sharedJob<MusicFile>();

/** An online song, sound only, into the files root. Concurrent callers share the download. */
function getOnline(url: string, deps: MusicDeps): Promise<MusicFile> {
	const root = path.resolve(deps.filesRoot);
	return onlineJob(root + "|" + url, deps.signal, (signal) => withScratch(root, signal,
		(scratch) => fetchOnline(url, { ...deps, filesRoot: root }, scratch, signal)));
}

async function fetchOnline(url: string, deps: MusicDeps, scratch: string, signal: AbortSignal): Promise<MusicFile> {
	if (!isHttpUrl(url)) throw new RetrievalError("an online song needs an http(s) link");
	await assertPublicUrl(url, deps.env, undefined, signal);
	const env = deps.env ?? process.env;
	const tools = deps.tools ?? toolsFromEnv(env);
	const runner = deps.runner ?? defaultRunner;
	const dir = path.join(deps.filesRoot, MUSIC_LIBRARY.folder, "online");
	const key = createHash("sha1").update(url).digest("hex").slice(0, 12);
	const legacyMeta = path.join(dir, key + ".json");
	const { meta, sidecars } = await cacheTargets(legacyMeta);
	const media = path.join(path.dirname(meta), key + ".m4a");
	const lookup = async (): Promise<MusicFile | undefined> => {
		for (const sidecar of sidecars) {
			const file = path.join(path.dirname(sidecar), key + ".m4a");
			if (!(await exists(file))) continue;
			try {
				const saved = JSON.parse(await fs.readFile(sidecar, "utf8")) as { name: string; pageUrl?: string; uploader?: string };
				return { path: toPosix(path.relative(deps.filesRoot, file)), name: saved.name, source: "online", pageUrl: saved.pageUrl, uploader: saved.uploader, cached: true };
			} catch {
				// Missing or unreadable sidecar.
			}
		}
	};
	const cached = await lookup();
	if (cached) return cached;
	const args = ["--ignore-config", "--no-cache-dir", "--no-playlist", "--no-warnings", "--no-progress", "--no-simulate", "-O", "%()j", "--force-overwrites", "--match-filter", `!is_live & duration <= ${maxSeconds(env)}`, "-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a"];
	if (tools.cookiesFromBrowser) args.push("--cookies-from-browser", tools.cookiesFromBrowser);
	const [command, ...rest] = tools.ffmpeg;
	if (rest.length === 0 && /[\\/]/.test(command)) args.push("--ffmpeg-location", command);
	args.push("-o", path.join(scratch, "song.%(ext)s"), "--", url);
	const stdout = await runTool(runner, tools.ytdlp, args, "yt-dlp", signal, scratch);
	const line = stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
	const info = line ? (JSON.parse(line) as { title?: string; uploader?: string; channel?: string; webpage_url?: string; duration?: number }) : undefined;
	let staged = path.join(scratch, "song.m4a");
	if (!info || !(await exists(staged))) throw new RetrievalError(`nothing was downloaded (longer than ${maxSeconds(env)} s, a live stream, or an unsupported link)`);
	const target = loudnessTarget(env);
	if (target !== null) {
		const normalized = path.join(scratch, "normalized.m4a");
		await runToolOutput(runner, tools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", staged, "-vn", "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11`, "-ar", "48000", "-c:a", "aac", "-b:a", "192k", normalized], "ffmpeg", signal, scratch);
		staged = normalized;
	}
	const result = { name: info.title ?? "song", uploader: info.uploader || info.channel, pageUrl: info.webpage_url || url, duration: info.duration, fetchedAt: new Date().toISOString() };
	if (!(await publishMedia(staged, media, signal, { file: meta, value: result }))) return reusePublished(lookup);
	clearLibraryIndex();
	return { path: toPosix(path.relative(deps.filesRoot, media)), name: result.name, source: "online", pageUrl: result.pageUrl, uploader: result.uploader, cached: false };
}

export async function getMusic(source: MusicSource, ref: string, deps: MusicDeps): Promise<MusicFile> {
	if (source === "online") return getOnline(ref, deps);
	const file = await getLibrary(ref, deps, MUSIC_LIBRARY);
	return { ...file, source: "library" };
}

const isSource = (value: unknown): value is MusicSource => typeof value === "string" && (MUSIC_SOURCES as readonly string[]).includes(value);

/**
 * Body of POST /api/agent/music:
 * `{kind:"search", query, sources?, limit?}` returns `{results, errors}`;
 * `{kind:"get", source, ref}` saves the song under AGENT_FILES_ROOT and returns its `path`
 * (`source:"online"` with any song link as `ref` works too);
 * `{kind:"find", query, sources?}` does both for the best match (library first).
 */
export async function handleMusic(body: unknown, deps: MusicDeps): Promise<{ status: number; body: unknown }> {
	const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const sources = input.sources === undefined ? MUSIC_SOURCES : Array.isArray(input.sources) && input.sources.every(isSource) ? (input.sources as MusicSource[]) : null;
	if (!sources) return { status: 400, body: { error: `sources must be a list of ${MUSIC_SOURCES.join(", ")}` } };
	const limit = Math.min(50, Math.max(1, Number.isInteger(input.limit) ? (input.limit as number) : 20));
	try {
		checkCancelled(deps.signal, "preparation");
		if (input.kind === "search" || input.kind === "find") {
			if (typeof input.query !== "string" || !words(input.query).length || input.query.length > 200) return { status: 400, body: { error: "query is required (up to 200 characters)" } };
			const found = await searchMusic(input.query, sources, deps, input.kind === "find" ? 1 : limit);
			if (input.kind === "search") return { status: 200, body: found };
			const best = found.results[0];
			if (!best) return { status: 404, body: { error: `no song found for "${input.query}"`, errors: found.errors } };
			return { status: 200, body: await getMusic(best.source, best.ref, deps) };
		}
		if (input.kind === "get") {
			if (!isSource(input.source) || typeof input.ref !== "string") return { status: 400, body: { error: "source and ref are required" } };
			return { status: 200, body: await getMusic(input.source, input.ref, deps) };
		}
		return { status: 400, body: { error: 'kind must be "search", "get" or "find"' } };
	} catch (error) {
		if (error instanceof RetrievalError) return { status: error instanceof Cancelled ? 499 : 502, body: { error: error.message } };
		throw error;
	}
}
