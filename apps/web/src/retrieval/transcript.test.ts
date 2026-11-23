import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getTranscript } from "./transcript";
import { runWithPrivateCookies } from "./yt-dlp-cookies";
import type { Runner } from "./server";

const url = "https://www.youtube.com/watch?v=example_id1";
const json3 = { ext: "json3", data: "fixture" };
const vttFormat = { ext: "vtt", data: "fixture" };
const captions = { en: [json3], es: [vttFormat] };
const timed = JSON.stringify({ events: [
	{ tStartMs: 1000, dDurationMs: 3300, segs: [{ utf8: "We go", tOffsetMs: 200 }, { utf8: " now", tOffsetMs: 950 }] },
	{ tStartMs: 1800, dDurationMs: 300, aAppend: 1, segs: [{ utf8: "\n" }] },
	{ tStartMs: 3500, dDurationMs: 1500, segs: [{ utf8: "We go", tOffsetMs: 0 }, { utf8: " again" }] },
	{ tStartMs: 5000, dDurationMs: 500, segs: [{ utf8: "[Music] ♪" }] },
	{ tStartMs: 5500, dDurationMs: 500, segs: [{ utf8: " " }] },
	{ tStartMs: 6000, dDurationMs: 500, segs: [{ utf8: "[Laughter] Keep going" }] },
] });
const vtt = "WEBVTT\n\n1\n00:01.000 --> 00:02.000 align:start\n<c>Uno &amp; dos</c>\n";
let workspace: string;
let calls: string[][];
let metadata: Record<string, unknown>;
let captionData: string | undefined;
let runner: Runner;
let scratch: string | undefined;

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "transcript-test-"));
	calls = [];
	scratch = undefined;
	metadata = { id: "example_id1", title: "Example video", extractor_key: "Youtube", webpage_url: url,
		duration: 12, language: "en", subtitles: captions, automatic_captions: captions };
	captionData = undefined;
	runner = async (_command, args) => {
		calls.push(args);
		if (!args.includes("--load-info-json")) return { stdout: JSON.stringify(metadata), stderr: "" };
		const infoFile = args[args.indexOf("--load-info-json") + 1];
		const info = JSON.parse(await readFile(infoFile, "utf8"));
		scratch = path.dirname(infoFile);
		const tracks = info.subtitles ?? info.automatic_captions;
		const [lang] = Object.keys(tracks);
		const ext = tracks[lang][0].ext;
		if (captionData !== "") await writeFile(path.join(scratch, `captions.${lang}.${ext}`), captionData ?? (ext === "vtt" ? vtt : timed));
		return { stdout: "", stderr: "" };
	};
});
afterEach(async () => { await rmdir(workspace); });

const get = (options: Partial<Parameters<typeof getTranscript>[0]> = {}, signal?: AbortSignal, run = runner, allowPrivate = "1") =>
	getTranscript({ url, ...options }, { workspace, runner: run, signal,
		env: { BOPENCUT_ALLOW_PRIVATE_URLS: allowPrivate, BOPENCUT_YTDLP: "fixture --proxy proxy", BOPENCUT_YTDLP_COOKIES_FROM_BROWSER: "firefox" } });

test("creator beats auto, original language beats track order, and --lang selects a VTT track", async () => {
	metadata.language = "es";
	expect(await get()).toMatchObject({ origin: "creator", language: "es",
		cues: [{ text: "Uno & dos", start: 1, end: 2 }] });
	const english = await get({ language: "en" });
	expect(english).toMatchObject({ origin: "creator", language: "en" });
	expect(english.cues[0].end).toBe(4.3);
	const spanish = await get({ language: "es" });
	expect(spanish.cues[0]).not.toHaveProperty("words");
	await expect(get({ language: "de" })).rejects.toThrow("captions unavailable");
});

test("an explicit original automatic track reports the plain language code", async () => {
	metadata.automatic_captions = { "en-orig": [json3] };
	expect(await get({ language: "EN" })).toMatchObject({ origin: "creator", language: "en" });
	expect(await get({ language: "en-orig" })).toMatchObject({ origin: "auto", language: "en" });
});

test("automatic JSON3 ignores append events and uses offsets and the next cue boundary", async () => {
	metadata.subtitles = {};
	metadata.automatic_captions = { en: [vttFormat, json3] };
	const result = await get();
	expect(calls[1]).toContain("json3");
	expect(result).toMatchObject({ origin: "auto", coverage: [{ start: 0, end: 12 }] });
	expect(result.cues).toEqual([
		{ text: "We go now", start: 1, end: 3.5, words: [{ text: "We go", start: 1.2, end: 1.95 }, { text: "now", start: 1.95, end: 3.5 }] },
		{ text: "We go again", start: 3.5, end: 5 },
		{ text: "[Music] ♪", start: 5, end: 5.5 },
		{ text: "[Laughter] Keep going", start: 6, end: 6.5 },
	]);
	expect(result.warnings).toEqual([
		"Dropped 1 empty caption cues.", "Kept 1 music or sound-effect-only caption cues.", expect.stringContaining("verify openings"),
	]);
});

test("automatic VTT is requested only when JSON3 is absent", async () => {
	metadata.subtitles = {};
	metadata.automatic_captions = { en: [vttFormat, json3] };
	captionData = "";
	await expect(get()).rejects.toThrow("captions unavailable");
	expect(calls).toHaveLength(2);
	expect(calls[1]).toContain("json3");
});

test("ranges overlap half-open edges and preserve full cue times", async () => {
	const result = await get({ range: { start: 4.3, end: 5 } });
	expect(result.cues).toEqual([{ text: "We go again", start: 3.5, end: 5 }]);
	expect((await get({ range: { start: 11, end: 12 } })).cues).toEqual([]);
});

test("creator VTT is tried if JSON3 is unusable and keeps inline word times", async () => {
	metadata.subtitles = { en: [json3, vttFormat] };
	const run: Runner = async (command, args, signal) => {
		captionData = args.includes("vtt")
			? "WEBVTT\n\n00:01.000 --> 00:03.000\nSay<00:00:01.500><c> hello</c>\n" : "";
		return runner(command, args, signal);
	};
	const result = await get({}, undefined, run);
	expect(result.cues).toEqual([{ text: "Say hello", start: 1, end: 3,
		words: [{ text: "Say", start: 1, end: 1.5 }, { text: "hello", start: 1.5, end: 3 }] }]);
	expect(result.origin).toBe("creator");
	metadata.subtitles = { en: [{ ext: "json3", url: "http://127.0.0.1/track" }, vttFormat] };
	expect((await get({ url: "https://192.0.2.1/video" }, undefined, run, "0")).cues).toEqual(result.cues);
});

test("automatic VTT keeps repeated lines and reports malformed timed blocks", async () => {
	metadata.subtitles = {};
	metadata.automatic_captions = { en: [vttFormat] };
	captionData = [
		"WEBVTT", "NOTE ignored", "00:00.000 --> 00:02.000\nSay this",
		"00:01.000 --> 00:01.010\nSay this",
		"00:01.010 --> 00:02.000\nSay this\nagain",
		"bad time --> 00:03.000\nWrong timestamp",
		"bad-id\n00:03.000 --> 00:02.000\nBackwards",
		"00:03.000 --> 00:04.000\nSay this",
	].join("\n\n");
	const result = await get();
	expect(result.cues).toEqual([
		{ start: 0, end: 2, text: "Say this" },
		{ start: 1, end: 1.01, text: "Say this" },
		{ start: 1.01, end: 2, text: "Say this\nagain" },
		{ start: 3, end: 4, text: "Say this" },
	]);
	expect(result.warnings).toContain("automatic VTT captions can repeat lines");
	expect(result.warnings).toContain("Dropped 2 caption cues with invalid timing.");
});

test("each call reads the source and leaves the workspace and scratch empty", async () => {
	expect((await get()).source.duration).toBe(12);
	expect(scratch).toBeDefined();
	await expect(readdir(scratch!)).rejects.toMatchObject({ code: "ENOENT" });
	metadata.duration = 24;
	expect((await get()).source.duration).toBe(24);
	expect(calls).toHaveLength(4);
	expect(await readdir(workspace)).toEqual([]);
	await expect(readdir(scratch!)).rejects.toMatchObject({ code: "ENOENT" });
});

test("live streams and unavailable captions are refused before downloading a track", async () => {
	metadata.is_live = true;
	await expect(get()).rejects.toThrow(/live stream.*replay/);
	metadata.is_live = false;
	metadata.subtitles = metadata.automatic_captions = {};
	await expect(get()).rejects.toThrow(/captions unavailable.*configured command/);
	expect(calls).toHaveLength(2);
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
	expect(await readdir(workspace)).toEqual([]);
});

test("both yt-dlp stages skip media and accept the existing private cookie integration", async () => {
	const marker = path.join(workspace, "cookie-state");
	await writeFile(marker, "copy");
	try {
		await get({}, undefined, async (command, args, signal) => {
			expect(args).toContain("--skip-download");
			expect(args).not.toContain("--download");
			expect(args).not.toContain("--download-sections");
			expect(args.slice(0, 2)).toEqual(["--proxy", "proxy"]);
			expect(args[args.indexOf("--cookies-from-browser") + 1]).toBe("firefox");
			return runWithPrivateCookies(args, workspace, signal ?? new AbortController().signal, (privateArgs) => {
				expect(privateArgs).toContain("BopencutJobCookies");
				return runner(command, privateArgs, signal);
			});
		});
		expect(calls).toHaveLength(2);
	} finally {
		await unlink(marker);
	}
});
