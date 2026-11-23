import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getTranscript } from "./transcript";
import { runWithPrivateCookies } from "./yt-dlp-cookies";
import type { Runner } from "./server";

const url = "https://www.youtube.com/watch?v=example_id1";
const captions = { en: [{ ext: "json3", data: "fixture" }], es: [{ ext: "vtt", data: "fixture" }] };
const timed = JSON.stringify({ events: [
	{ tStartMs: 0, dDurationMs: 2300, segs: [{ utf8: "We", tOffsetMs: 0 }, { utf8: " go", tOffsetMs: 900 }] },
	{ tStartMs: 900, dDurationMs: 2600, segs: [{ utf8: "go", tOffsetMs: 0 }, { utf8: " now", tOffsetMs: 1500 }] },
	{ tStartMs: 3500, dDurationMs: 500, segs: [{ utf8: "[Music] ♪" }] },
	{ tStartMs: 4000, dDurationMs: 500, segs: [{ utf8: " " }] },
	{ tStartMs: 4500, dDurationMs: 500, segs: [{ utf8: "[Laughter] Keep going" }] },
] });
const vtt = "WEBVTT\n\n1\n00:01.000 --> 00:02.000 align:start\n<c>Uno &amp; dos</c>\n";
let workspace: string;
let cache: string;
let calls: string[][];
let metadata: Record<string, unknown>;
let captionData: string | undefined;
let runner: Runner;
let scratch: string | undefined;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "transcript-test-"));
	cache = path.join(workspace, "cache", "transcripts", "v1");
	calls = [];
	scratch = undefined;
	metadata = { id: "example_id1", extractor_key: "Youtube", webpage_url: url, duration: 12,
		language: "en", subtitles: captions, automatic_captions: captions };
	captionData = undefined;
	runner = async (_command, args) => {
		calls.push(args);
		const infoFile = args[args.indexOf("--load-info-json") + 1];
		if (!args.includes("--load-info-json")) return { stdout: JSON.stringify(metadata), stderr: "" };
		const info = JSON.parse(await readFile(infoFile, "utf8"));
		scratch = path.dirname(infoFile);
		const tracks = info.subtitles ?? info.automatic_captions;
		const [lang] = Object.keys(tracks);
		const ext = tracks[lang][0].ext;
		if (captionData !== "") await writeFile(path.join(scratch, `captions.${lang}.${ext}`), captionData ?? (ext === "vtt" ? vtt : timed));
		return { stdout: "", stderr: "" };
	};
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

const get = (options: Partial<Parameters<typeof getTranscript>[0]> = {}, signal?: AbortSignal, run = runner) =>
	getTranscript({ url, ...options }, { workspace, runner: run, signal,
		env: { BOPENCUT_ALLOW_PRIVATE_URLS: "1", BOPENCUT_YTDLP: "fixture --proxy proxy", BOPENCUT_YTDLP_COOKIES_FROM_BROWSER: "firefox" } });

test("creator beats auto, original language beats track order, and --lang selects a VTT track", async () => {
	metadata.language = "es";
	expect(await get()).toMatchObject({ origin: "creator", language: "es",
		cues: [{ text: "Uno & dos", start: 1, end: 2 }] });
	expect(await get({ language: "en" })).toMatchObject({ origin: "creator", language: "en" });
	const spanish = await get({ language: "es" });
	expect(spanish.cues[0]).not.toHaveProperty("words");
	await expect(get({ language: "de" })).rejects.toThrow("captions unavailable");
});

test("rolling captions keep novel words and their source times, while dropping standalone tags", async () => {
	metadata.subtitles = {};
	const result = await get();
	expect(result).toMatchObject({ origin: "auto", coverage: [{ start: 0, end: 12 }] });
	expect(result.cues).toEqual([
		{ text: "We go", start: 0, end: 2.3, words: [{ text: "We", start: 0, end: 0.9 }, { text: "go", start: 0.9, end: 2.3 }] },
		{ text: "now", start: 2.4, end: 3.5, words: [{ text: "now", start: 2.4, end: 3.5 }] },
		{ text: "[Laughter] Keep going", start: 4.5, end: 5 },
	]);
	expect(result.warnings.join(" ")).toMatch(/2.*empty or noise/i);
	expect(result.warnings.join(" ")).toContain("verify openings");
});

test("ranges overlap half-open edges and preserve full cue times", async () => {
	const result = await get({ range: { start: 2.3, end: 4.5 } });
	expect(result.cues.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 0.9, end: 3.5 }]);
	expect((await get({ range: { start: 11, end: 12 } })).cues).toEqual([]);
	expect(calls).toHaveLength(2);
});

test("creator VTT is tried if JSON3 is unusable and keeps inline word times", async () => {
	metadata.subtitles = { en: [...captions.en, ...captions.es] };
	const run: Runner = async (command, args, signal) => {
		captionData = args.includes("vtt")
			? "WEBVTT\n\n00:01.000 --> 00:03.000\nSay<00:01.500><c> hello</c>\n" : "";
		return runner(command, args, signal);
	};
	const result = await get({}, undefined, run);
	expect(result.cues).toEqual([{ text: "Say hello", start: 1, end: 3,
		words: [{ text: "Say", start: 1, end: 1.5 }, { text: "hello", start: 1.5, end: 3 }] }]);
	expect(result.origin).toBe("creator");
});

test("rolling VTT skips brief adjacent echo cues and keeps repeated speech at later times", async () => {
	metadata.subtitles = {};
	metadata.automatic_captions = { en: captions.es };
	captionData = [
		"WEBVTT", "00:00.000 --> 00:01.000\nSay this",
		"00:01.000 --> 00:01.010\nSay this",
		"00:01.010 --> 00:02.000\nSay this\nagain",
		"00:03.000 --> 00:04.000\nSay this",
	].join("\n\n");
	expect((await get()).cues.map((cue) => cue.text)).toEqual(["Say this", "again", "Say this"]);
});

test("cache hits and YouTube aliases are disk-only, and refresh updates the shared entry", async () => {
	expect((await get()).cached).toBe(false);
	expect((await get({ url: "https://youtu.be/example_id1?si=share", language: "en" })).cached).toBe(true);
	expect(calls).toHaveLength(2);
	expect(await readdir(cache)).toContain("youtube-example_id1.en.creator.json");
	expect((await get({ refresh: true })).cached).toBe(false);
	expect(calls).toHaveLength(4);
	metadata.duration = 24;
	expect(await get({ url: "https://example.com/alias" })).toMatchObject({ cached: false, source: { duration: 24 } });
	expect(calls).toHaveLength(6);
	expect(await get()).toMatchObject({ cached: true, source: { duration: 24 } });
	metadata.subtitles = { en: [{ ...captions.en[0], last_modified: "2026-02-01" }] };
	expect((await get({ url: "https://example.com/newer" })).cached).toBe(false);
	expect(calls).toHaveLength(8);
	expect((await get({ url: "https://example.com/newer" })).cached).toBe(true);
	expect(calls).toHaveLength(8);
});

test("live streams and unavailable captions leave no cache entry", async () => {
	metadata.is_live = true;
	await expect(get()).rejects.toThrow(/live stream.*replay/);
	metadata.is_live = false;
	metadata.subtitles = metadata.automatic_captions = {};
	await expect(get()).rejects.toThrow(/captions unavailable.*configured command/);
	expect(calls).toHaveLength(2);
	expect((await readdir(cache)).filter((file) => file.endsWith(".json"))).toEqual([]);
});

test("cancellation waits for the runner and removes its partial captions", async () => {
	const controller = new AbortController();
	const run: Runner = async (command, args, signal) => {
		const result = await runner(command, args, signal);
		if (scratch) controller.abort();
		return result;
	};
	await expect(get({}, controller.signal, run)).rejects.toThrow(/cancelled/);
	expect(scratch).toBeDefined();
	await expect(readdir(scratch!)).rejects.toMatchObject({ code: "ENOENT" });
	expect((await readdir(cache)).filter((file) => file.endsWith(".json"))).toEqual([]);
});

test("cache folders cannot traverse a link", async () => {
	const outside = await mkdtemp(path.join(tmpdir(), "transcript-outside-"));
	const link = path.join(workspace, "cache");
	await symlink(outside, link, "junction");
	try {
		await expect(get()).rejects.toThrow(/cache.*link/i);
		expect(calls).toEqual([]);
		expect(await readdir(outside)).toEqual([]);
	} finally {
		await unlink(link);
		await rmdir(outside);
	}
});

test("both yt-dlp stages skip media and accept the existing private cookie integration", async () => {
	const temp = path.join(workspace, "private");
	await mkdir(temp);
	await writeFile(path.join(temp, "cookie-state"), "copy");
	await get({}, undefined, async (command, args, signal) => {
		expect(args).toContain("--skip-download");
		expect(args).not.toContain("--download");
		expect(args).not.toContain("--download-sections");
		expect(args.slice(0, 2)).toEqual(["--proxy", "proxy"]);
		expect(args[args.indexOf("--cookies-from-browser") + 1]).toBe("firefox");
		return runWithPrivateCookies(args, temp, signal!, (privateArgs) => {
			expect(privateArgs).toContain("BopencutJobCookies");
			return runner(command, privateArgs, signal);
		});
	});
	expect(calls).toHaveLength(2);
});
