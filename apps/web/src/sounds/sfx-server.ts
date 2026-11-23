// Sound effect library for the user and agents: the user's own sound folders plus myinstants.com.
// Node only: used by the agent API route and the sfx CLI.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { type Runner, type RetrievalTools, RetrievalError, defaultRunner, runToolOutput, toolsFromEnv } from "@/retrieval/server";
import { Cancelled, cacheTargets, checkCancelled, publishMedia, reusePublished, withScratch } from "@/retrieval/jobs";
import { fetchPublic, readCapped } from "@/retrieval/net";
import { SFX_SOURCES, type SfxFile, type SfxResult, type SfxSource } from "./sfx-types";

const AUDIO_EXT = /\.(mp3|wav|m4a|ogg|oga|flac|aac|opus)$/i;
const MYINSTANTS = "https://www.myinstants.com";
const SOUND_PATH = /^\/media\/sounds\/[^/?#\\]+\.(mp3|wav|ogg)$/i;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const USER_AGENT = "Mozilla/5.0 (compatible; bopencut)";

export type SfxDeps = {
	filesRoot: string;
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
	runner?: Runner;
	signal?: AbortSignal;
	tools?: RetrievalTools;
};

/** A kind of sound library: its folder under AGENT_FILES_ROOT, the variable with more folders, and its preview route. */
export type LibraryKind = { folder: string; envVar: string; previewRoute: string };
export const SFX_LIBRARY: LibraryKind = { folder: "sfx", envVar: "BOPENCUT_SFX_DIRS", previewRoute: "/api/agent/sfx-file" };

/**
 * Library folders: `<filesRoot>/<folder>` (where fetched sounds are saved) first, then the kind's variable
 * (BOPENCUT_SFX_DIRS for sound effects), separated by the platform path delimiter: `;` on Windows, `:` elsewhere.
 */
export function libraryRoots(filesRoot: string, env: Record<string, string | undefined> = process.env, kind: LibraryKind = SFX_LIBRARY): string[] {
	const extra = (env[kind.envVar] ?? "").split(path.delimiter).map((d) => d.trim()).filter(Boolean);
	const roots = [path.join(filesRoot, kind.folder), ...extra].map((d) => path.resolve(d));
	return roots.filter((d, i) => roots.indexOf(d) === i);
}

/** Lowercase words without accents, for matching. */
export function words(text: string): string[] {
	return text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

type Entry = { root: number; rel: string; name: string; nameWords: string[]; tags: string[] };

/** "vine-boom_48k.wav" -> "vine boom 48k", "Dexter - Blood Theme.mp3" -> "Dexter Blood Theme". */
export function titleFromFile(fileName: string): string {
	return fileName.replace(AUDIO_EXT, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

async function scan(rootIndex: number, root: string, signal?: AbortSignal): Promise<Entry[]> {
	const entries: Entry[] = [];
	const walk = async (dir: string, depth: number) => {
		checkCancelled(signal, "library search");
		if (depth > 8 || entries.length >= 50000) return;
		let items: import("node:fs").Dirent[];
		try {
			items = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const present = new Set(items.map((item) => item.name));
		for (const item of items) {
			checkCancelled(signal, "library search");
			if (item.name.startsWith(".")) continue;
			const full = path.join(dir, item.name);
			if (item.isDirectory()) await walk(full, depth + 1);
			else if (item.isFile() && AUDIO_EXT.test(item.name)) {
				const rel = path.relative(root, full).split(path.sep).join("/");
				// A saved sound's sidecar (`<name>.json`) keeps its real title; otherwise the file name is the title.
				const sidecar = item.name.replace(AUDIO_EXT, ".json");
				let name = titleFromFile(item.name);
				if (present.has(sidecar)) {
					try {
						const saved = JSON.parse(await fs.readFile(path.join(dir, sidecar), "utf8")) as { name?: unknown };
						if (typeof saved.name === "string" && saved.name.trim()) name = saved.name.trim();
					} catch {
						// unreadable sidecar: keep the file name
					}
				}
				entries.push({ root: rootIndex, rel, name, nameWords: words(name), tags: rel.split("/").slice(0, -1).flatMap(words) });
			}
		}
	};
	await walk(root, 0);
	return entries;
}

const indexCache = new Map<string, { at: number; entries: Entry[] }>();
const INDEX_TTL_MS = 30_000;

async function libraryIndex(roots: string[], signal?: AbortSignal): Promise<Entry[]> {
	const all: Entry[] = [];
	for (const [i, root] of roots.entries()) {
		const cached = indexCache.get(`${i}:${root}`);
		if (cached && Date.now() - cached.at < INDEX_TTL_MS) {
			all.push(...cached.entries);
			continue;
		}
		const entries = await scan(i, root, signal);
		indexCache.set(`${i}:${root}`, { at: Date.now(), entries });
		all.push(...entries);
	}
	return all;
}

/** Forget the cached folder listings (after saving a new sound, or in tests). */
export function clearLibraryIndex() {
	indexCache.clear();
}

/** Every query word must match the name or a folder tag; exact words rank above prefixes, names above tags. */
export function scoreEntry(queryWords: string[], entry: { nameWords: string[]; tags: string[] }): number {
	let score = 0;
	for (const q of queryWords) {
		if (entry.nameWords.includes(q)) score += 3;
		else if (entry.nameWords.some((w) => w.startsWith(q))) score += 2;
		else if (entry.tags.some((t) => t === q || t.startsWith(q))) score += 1;
		else return 0;
	}
	return score;
}

const libraryRef = (entry: Entry) => `lib:${entry.root}:${entry.rel}`;

/** Resolves a `lib:<root>:<rel>` reference to a file inside that library folder, or throws. */
export function resolveLibraryRef(ref: string, roots: string[]): { root: string; file: string; rel: string } {
	const m = /^lib:(\d+):(.+)$/.exec(ref);
	if (!m) throw new RetrievalError("invalid library reference");
	const root = roots[Number(m[1])];
	if (!root) throw new RetrievalError("unknown library folder");
	const file = path.resolve(root, m[2]);
	if (!file.startsWith(root + path.sep) || !AUDIO_EXT.test(file)) throw new RetrievalError("invalid library reference");
	return { root, file, rel: m[2] };
}

/**
 * The library file a reference names, after following symlinks and junctions: it must still be inside
 * its library folder (also resolved), or the reference is refused.
 */
export async function resolveLibraryFile(ref: string, roots: string[]): Promise<string> {
	const { root, file } = resolveLibraryRef(ref, roots);
	let realRoot: string;
	let realFile: string;
	try {
		[realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
	} catch {
		throw new RetrievalError("library sound not found");
	}
	if (!realFile.startsWith(realRoot + path.sep) || !AUDIO_EXT.test(realFile)) throw new RetrievalError("invalid library reference");
	return realFile;
}

/** Title of a library file: its sidecar's `name` when it has one, otherwise from the file name. */
export async function libraryTitle(file: string): Promise<string> {
	try {
		const saved = JSON.parse(await fs.readFile(file.replace(AUDIO_EXT, ".json"), "utf8")) as { name?: unknown };
		if (typeof saved.name === "string" && saved.name.trim()) return saved.name.trim();
	} catch {
		// no sidecar
	}
	return path.basename(file).replace(AUDIO_EXT, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export async function searchLibrary(query: string, { filesRoot, env = process.env, signal }: SfxDeps, limit = 20, kind: LibraryKind = SFX_LIBRARY): Promise<SfxResult[]> {
	const q = words(query);
	if (!q.length) return [];
	const roots = libraryRoots(filesRoot, env, kind);
	const scored = (await libraryIndex(roots, signal))
		.map((entry) => ({ entry, score: scoreEntry(q, entry) }))
		.filter((s) => s.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length);
	return scored.slice(0, limit).map(({ entry }) => ({
		source: "library" as const,
		ref: libraryRef(entry),
		name: entry.name,
		tags: entry.tags,
		previewUrl: `${kind.previewRoute}?ref=${encodeURIComponent(libraryRef(entry))}`,
	}));
}

function decodeEntities(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.trim();
}

/** Results of a myinstants.com search page: one per instant button. */
export function parseMyinstants(html: string): SfxResult[] {
	const results: SfxResult[] = [];
	for (const block of html.split('<div class="instant">').slice(1)) {
		const play = /play\('([^']+)',\s*'[^']*',\s*'([^']+)'\)/.exec(block);
		const name = /class="instant-link[^"]*"[^>]*>([^<]+)</.exec(block);
		if (!play || !name || !SOUND_PATH.test(play[1])) continue;
		const ref = play[1];
		if (results.some((r) => r.ref === ref)) continue;
		results.push({
			source: "myinstants",
			ref,
			name: decodeEntities(name[1]),
			tags: [],
			previewUrl: MYINSTANTS + ref,
			pageUrl: `${MYINSTANTS}/en/instant/${encodeURIComponent(play[2])}/`,
		});
	}
	return results;
}

export async function searchMyinstants(query: string, deps: SfxDeps, limit = 20): Promise<SfxResult[]> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	if (!query.trim()) return [];
	const res = await fetchPublic(`${MYINSTANTS}/en/search/?name=${encodeURIComponent(query.trim())}`, { headers: { "User-Agent": USER_AGENT }, fetchImpl, env: deps.env, timeoutMs: 20_000, signal: deps.signal });
	if (!res.ok) {
		await res.body?.cancel();
		throw new RetrievalError(`myinstants search failed (${res.status})`);
	}
	const html = (await readCapped(res, 5 * 1024 * 1024)).toString("utf8");
	// Myinstants also matches tags; results whose title has the query words come first (stable otherwise).
	const q = words(query);
	return parseMyinstants(html)
		.map((result, i) => ({ result, i, score: scoreEntry(q, { nameWords: words(result.name), tags: [] }) }))
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.slice(0, limit)
		.map(({ result }) => result);
}

/** Search the chosen sources; a failing source is reported in `errors` and the others still return results. */
export async function searchSfx(query: string, sources: readonly SfxSource[], deps: SfxDeps, limit = 20): Promise<{ results: SfxResult[]; errors: { source: SfxSource; error: string }[] }> {
	const results: SfxResult[] = [];
	const errors: { source: SfxSource; error: string }[] = [];
	for (const source of sources) {
		try {
			results.push(...(source === "library" ? await searchLibrary(query, deps, limit) : await searchMyinstants(query, deps, limit)));
		} catch (error) {
			checkCancelled(deps.signal, "sound search");
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
const safeStem = (name: string) => name.replace(/[^a-zA-Z0-9._ -]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "sound";
/** A safe file name whose audio extension survives truncation. */
const safeFileName = (fileName: string) => {
	const ext = (AUDIO_EXT.exec(fileName)?.[0] ?? "").toLowerCase();
	return safeStem(ext ? fileName.slice(0, -ext.length) : fileName) + ext;
};

/** Peak-normalizes to -1 dBFS into an AAC m4a (BOPENCUT_SFX_NORMALIZE=off keeps the file as downloaded). */
async function normalizeInto(input: string, output: string, deps: SfxDeps): Promise<boolean> {
	const env = deps.env ?? process.env;
	if ((env.BOPENCUT_SFX_NORMALIZE ?? "peak").toLowerCase() === "off") return false;
	const tools = deps.tools ?? toolsFromEnv(env);
	const runner = deps.runner ?? defaultRunner;
	try {
		const probe = await runToolOutput(runner, tools.ffmpeg, ["-hide_banner", "-nostats", "-i", input, "-af", "volumedetect", "-f", "null", "-"], "ffmpeg", deps.signal, path.dirname(input));
		const max = /max_volume:\s*(-?[\d.]+) dB/.exec(probe.stderr);
		const gain = max ? Math.min(30, -1 - Number(max[1])) : 0;
		await runToolOutput(runner, tools.ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vn", "-af", `volume=${gain.toFixed(2)}dB`, "-c:a", "aac", "-b:a", "192k", output], "ffmpeg", deps.signal, path.dirname(input));
		return true;
	} catch (error) {
		if (error instanceof RetrievalError && /not found/.test(error.message)) return false;
		throw error;
	}
}

/** Title and page from a search result; the file name on myinstants often differs from the title. */
export type SfxLabel = { name?: string; pageUrl?: string };

function cleanLabel(label: SfxLabel = {}): SfxLabel {
	const name = typeof label.name === "string" ? label.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
	const pageUrl = typeof label.pageUrl === "string" && label.pageUrl.startsWith(`${MYINSTANTS}/`) ? label.pageUrl : undefined;
	return { ...(name ? { name } : {}), ...(pageUrl ? { pageUrl } : {}) };
}

async function getMyinstants(ref: string, deps: SfxDeps, label: SfxLabel = {}): Promise<SfxFile> {
	checkCancelled(deps.signal, "sound lookup");
	if (!SOUND_PATH.test(ref)) throw new RetrievalError("invalid myinstants reference");
	const dir = path.join(deps.filesRoot, "sfx", "myinstants");
	// The file name plus a hash of the whole reference: two sounds with the same file name never share a cache entry.
	const base = `${safeStem(decodeURIComponent(path.posix.basename(ref)).replace(AUDIO_EXT, ""))}-${createHash("sha1").update(ref).digest("hex").slice(0, 6)}`;
	const legacyMeta = path.join(dir, base + ".json");
	const { meta, sidecars } = await cacheTargets(legacyMeta);
	const lookup = async (): Promise<SfxFile | undefined> => {
		for (const sidecar of sidecars) {
			for (const ext of [".m4a", path.extname(ref).toLowerCase()]) {
				const file = path.join(path.dirname(sidecar), base + ext);
				if (!(await exists(file))) continue;
				try {
					const saved = JSON.parse(await fs.readFile(sidecar, "utf8")) as { name: string; pageUrl?: string };
					return { path: toPosix(path.relative(deps.filesRoot, file)), name: saved.name, source: "myinstants", pageUrl: saved.pageUrl, cached: true };
				} catch {
					// Missing or unreadable sidecar.
				}
			}
		}
	};
	const cached = await lookup();
	checkCancelled(deps.signal, "sound lookup");
	if (cached) return cached;
	return withScratch(path.resolve(deps.filesRoot), deps.signal, async (scratch, signal) => {
		const res = await fetchPublic(MYINSTANTS + ref, { headers: { "User-Agent": USER_AGENT }, fetchImpl: deps.fetchImpl, env: deps.env, timeoutMs: 30_000, signal });
		if (!res.ok) {
			await res.body?.cancel();
			throw new RetrievalError(`myinstants download failed (${res.status})`);
		}
		const bytes = await readCapped(res, MAX_DOWNLOAD_BYTES);
		if (bytes.length === 0) throw new RetrievalError("myinstants returned an empty file");
		const ext = path.extname(ref).toLowerCase();
		const raw = path.join(scratch, "download" + ext);
		const normalized = path.join(scratch, "normalized.m4a");
		await fs.writeFile(raw, bytes, { signal });
		const encoded = await normalizeInto(raw, normalized, { ...deps, signal });
		const file = path.join(path.dirname(meta), base + (encoded ? ".m4a" : ext));
		const given = cleanLabel(label);
		const name = given.name ?? titleFromFile(decodeURIComponent(path.posix.basename(ref)));
		const pageUrl = given.pageUrl ?? `${MYINSTANTS}/en/search/?name=${encodeURIComponent(name)}`;
		if (!(await publishMedia(encoded ? normalized : raw, file, signal, {
			file: meta, value: { name, pageUrl, soundUrl: MYINSTANTS + ref, fetchedAt: new Date().toISOString() },
		}))) return reusePublished(lookup);
		clearLibraryIndex();
		return { path: toPosix(path.relative(deps.filesRoot, file)), name, source: "myinstants", pageUrl, cached: false };
	});

}

/** A library sound: used in place when it is under AGENT_FILES_ROOT, otherwise copied into `sfx/library/` once. */
export async function getLibrary(ref: string, deps: SfxDeps, kind: LibraryKind = SFX_LIBRARY): Promise<SfxFile> {
	checkCancelled(deps.signal, "library lookup");
	const roots = libraryRoots(deps.filesRoot, deps.env, kind);
	const file = await resolveLibraryFile(ref, roots);
	const stat = await fs.stat(file).catch(() => null);
	if (!stat?.isFile()) throw new RetrievalError("library sound not found");
	const name = await libraryTitle(file);
	const filesRoot = await fs.realpath(deps.filesRoot).catch(() => path.resolve(deps.filesRoot));
	checkCancelled(deps.signal, "library lookup");
	if (file.startsWith(filesRoot + path.sep)) return { path: toPosix(path.relative(filesRoot, file)), name, source: "library", cached: true };
	const hash = createHash("sha1").update(`${file}|${stat.size}|${stat.mtimeMs}`).digest("hex").slice(0, 8);
	const copy = path.join(filesRoot, kind.folder, "library", `${hash}-${safeFileName(path.basename(file))}`);
	if (await exists(copy)) return { path: toPosix(path.relative(filesRoot, copy)), name, source: "library", cached: true };
	return withScratch(filesRoot, deps.signal, async (scratch, signal) => {
		const part = path.join(scratch, "library");
		await fs.copyFile(file, part);
		await publishMedia(part, copy, signal);
		return { path: toPosix(path.relative(filesRoot, copy)), name, source: "library", cached: false };
	});
}

export function getSfx(source: SfxSource, ref: string, deps: SfxDeps, label?: SfxLabel): Promise<SfxFile> {
	return source === "library" ? getLibrary(ref, deps) : getMyinstants(ref, deps, label);
}

/** A library file to stream for a preview, or null when the reference is not valid. */
export async function libraryPreviewFile(ref: string, deps: SfxDeps, kind: LibraryKind = SFX_LIBRARY): Promise<string | null> {
	try {
		const file = await resolveLibraryFile(ref, libraryRoots(deps.filesRoot, deps.env, kind));
		return (await fs.stat(file)).isFile() ? file : null;
	} catch {
		return null;
	}
}

const isSource = (value: unknown): value is SfxSource => typeof value === "string" && (SFX_SOURCES as readonly string[]).includes(value);

/**
 * Body of POST /api/agent/sfx:
 * `{kind:"search", query, sources?, limit?}` returns `{results, errors}`;
 * `{kind:"get", source, ref, name?, pageUrl?}` saves the sound under AGENT_FILES_ROOT and returns its `path`
 * (pass the search result's `name` and `pageUrl` so the saved sound keeps its title);
 * `{kind:"find", query, sources?}` does both for the best match.
 */
export async function handleSfx(body: unknown, deps: SfxDeps): Promise<{ status: number; body: unknown }> {
	const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
	const sources = input.sources === undefined ? SFX_SOURCES : Array.isArray(input.sources) && input.sources.every(isSource) ? (input.sources as SfxSource[]) : null;
	if (!sources) return { status: 400, body: { error: `sources must be a list of ${SFX_SOURCES.join(", ")}` } };
	const limit = Math.min(50, Math.max(1, Number.isInteger(input.limit) ? (input.limit as number) : 20));
	try {
		checkCancelled(deps.signal, "preparation");
		if (input.kind === "search" || input.kind === "find") {
			if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200) return { status: 400, body: { error: "query is required (up to 200 characters)" } };
			if (input.kind === "search") return { status: 200, body: await searchSfx(input.query, sources, deps, limit) };
			// find asks the sources in order and stops at the first match, so a local hit never goes online.
			const errors: { source: SfxSource; error: string }[] = [];
			for (const source of sources) {
				const found = await searchSfx(input.query, [source], deps, 1);
				errors.push(...found.errors);
				const best = found.results[0];
				if (best) return { status: 200, body: await getSfx(best.source, best.ref, deps, best) };
			}
			return { status: 404, body: { error: `no sound found for "${input.query}"`, errors } };
		}
		if (input.kind === "get") {
			if (!isSource(input.source) || typeof input.ref !== "string") return { status: 400, body: { error: "source and ref are required" } };
			return { status: 200, body: await getSfx(input.source, input.ref, deps, { name: input.name as string | undefined, pageUrl: input.pageUrl as string | undefined }) };
		}
		return { status: 400, body: { error: 'kind must be "search", "get" or "find"' } };
	} catch (error) {
		if (error instanceof RetrievalError) return { status: error instanceof Cancelled ? 499 : 502, body: { error: error.message } };
		throw error;
	}
}
