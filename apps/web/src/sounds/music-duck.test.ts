import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Runner } from "@/retrieval/server";
import { duckKeyframes, frameLevels, mergeSegments, speechSegments } from "./duck";
import { computeDuck, handleDuck, validateDuck } from "./duck-server";
import { handleMusic } from "./music-server";
import { clearLibraryIndex } from "./sfx-server";

/** A level track: -70 dBFS of silence with louder "speech" frames in the given frame ranges. */
const levels = (count: number, loud: [number, number][]) => Array.from({ length: count }, (_, i) => (loud.some(([a, b]) => i >= a && i < b) ? -18 : -70));

describe("speech detection", () => {
	test("frame levels in dBFS", () => {
		const samples = new Float32Array(1600).fill(0.5);
		const l = frameLevels(samples, 16000, 0.02);
		expect(l).toHaveLength(5);
		expect(l[0]).toBeCloseTo(-6.02, 1);
		expect(frameLevels(new Float32Array(320), 16000)[0]).toBe(-120);
	});
	test("segments with short pauses joined and blips dropped", () => {
		// frames of 20 ms: speech 1.0-2.0 s, a 0.2 s pause, speech 2.2-3.0 s, a 0.06 s blip at 5 s
		const s = speechSegments(levels(300, [[50, 100], [110, 150], [250, 253]]));
		expect(s).toEqual([{ start: 1, end: 3 }]);
	});
	test("no contrast means no speech", () => {
		expect(speechSegments(Array(200).fill(-30))).toEqual([]);
	});
	test("merge", () => {
		expect(mergeSegments([{ start: 5, end: 6 }, { start: 1, end: 2 }, { start: 2.1, end: 3 }], 0.2)).toEqual([{ start: 1, end: 3 }, { start: 5, end: 6 }]);
	});
});

describe("duck keyframes", () => {
	test("down before speech, back up after, base elsewhere", () => {
		const k = duckKeyframes([{ start: 2, end: 4 }], { duration: 10, baseDb: -6, amountDb: -12, attack: 0.2, release: 0.5 });
		expect(k).toEqual([
			{ path: "volume", time: 0, value: -6 },
			{ path: "volume", time: 1.8, value: -6 },
			{ path: "volume", time: 2, value: -18 },
			{ path: "volume", time: 4, value: -18 },
			{ path: "volume", time: 4.5, value: -6 },
		]);
	});
	test("close sentences stay down between them; speech at 0 starts down", () => {
		const k = duckKeyframes([{ start: 0, end: 1 }, { start: 1.4, end: 2 }], { duration: 3, amountDb: -10, attack: 0.1, release: 0.4 });
		expect(k.map((p) => [p.time, p.value])).toEqual([[0, -10], [2, -10], [2.4, 0]]);
	});
	test("no speech, no keyframes", () => {
		expect(duckKeyframes([], { duration: 5 })).toEqual([]);
	});
});

describe("duck requests", () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "duck-"));
		await fs.writeFile(path.join(root, "voice.wav"), "x");
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("voice timing maps into music time", async () => {
		const calls: [string, number, number][] = [];
		// 16 kHz samples: 1 s of silence, 1 s of speech, 1 s of silence
		const reader = async (file: string, start: number, duration: number) => {
			calls.push([path.basename(file), start, duration]);
			const s = new Float32Array(48000);
			for (let i = 16000; i < 32000; i++) s[i] = 0.3 * Math.sin(i / 3);
			return s;
		};
		const r = await computeDuck({ music: { duration: 20, start: 10 }, voices: [{ path: "voice.wav", start: 15, trimStart: 4, duration: 3 }], amountDb: -12 }, { filesRoot: root, reader });
		expect(calls).toEqual([["voice.wav", 4, 3]]);
		expect(r.segments).toEqual([{ start: 6, end: 7 }]);
		expect(r.keyframes.map((k) => k.time)).toEqual([0, 5.85, 6, 7, 7.5]);
	});

	test("validation and paths outside the files root", async () => {
		expect(validateDuck({ voices: [] }).ok).toBe(false);
		expect(validateDuck({ music: { duration: 5 }, voices: [{ path: "a.wav", start: 0 }] }).ok).toBe(false);
		expect(validateDuck({ music: { duration: 5 }, voices: [{ path: "a.wav", start: 0, duration: 5 }], amountDb: 3 }).ok).toBe(false);
		const outside = await handleDuck({ music: { duration: 5 }, voices: [{ path: "../x.wav", start: 0, duration: 5 }] }, { filesRoot: root, reader: async () => new Float32Array(10) });
		expect(outside.status).toBe(502);
	});
});

describe("music", () => {
	let root: string;
	let extra: string;
	let calls: string[][];
	const search = { entries: [
		{ id: "a", title: "Nocturne Op. 9 No. 2", url: "https://www.youtube.com/watch?v=a", duration: 270, channel: "Pianist" },
		{ id: "b", title: "Nocturne 10 hours", url: "https://www.youtube.com/watch?v=b", duration: 36000 },
		{ id: "c", title: "Nocturne live", url: "https://www.youtube.com/watch?v=c", duration: 100, live_status: "is_live" },
	] };
	const runner: Runner = async (_command, args) => {
		calls.push(args);
		if (args.includes("--flat-playlist")) return { stdout: JSON.stringify(search), stderr: "" };
		const o = args.indexOf("-o");
		if (o >= 0) {
			await fs.writeFile((args[o + 1] as string).replace("%(ext)s", "m4a"), "song");
			return { stdout: `${JSON.stringify({ title: "Nocturne Op. 9 No. 2", uploader: "Pianist", webpage_url: "https://www.youtube.com/watch?v=a", duration: 270 })}\n`, stderr: "" };
		}
		await fs.writeFile(args.at(-1) as string, "loud");
		return { stdout: "", stderr: "" };
	};
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "music-root-"));
		extra = await fs.mkdtemp(path.join(os.tmpdir(), "music-extra-"));
		await fs.writeFile(path.join(extra, "Dexter - Blood Theme.mp3"), "mp3");
		calls = [];
		clearLibraryIndex();
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(extra, { recursive: true, force: true });
	});

	test("library first, then online songs without long videos or live streams", async () => {
		const env = { BOPENCUT_MUSIC_DIRS: extra };
		const r = await handleMusic({ kind: "search", query: "dexter" }, { filesRoot: root, env, runner });
		const body = r.body as { results: { source: string; name: string; previewUrl?: string }[] };
		expect(body.results[0]).toMatchObject({ source: "library", name: "Dexter Blood Theme" });
		expect(body.results[0].previewUrl).toStartWith("/api/agent/music-file?ref=");
		const online = await handleMusic({ kind: "search", query: "nocturne", sources: ["online"] }, { filesRoot: root, env, runner });
		expect((online.body as { results: { name: string }[] }).results.map((x) => x.name)).toEqual(["Nocturne Op. 9 No. 2"]);
	});

	test("an online song is fetched once, sound only, loudness-normalized, and joins the library", async () => {
		const env = {};
		const first = (await handleMusic({ kind: "find", query: "nocturne", sources: ["online"] }, { filesRoot: root, env, runner })).body as { path: string; name: string; uploader: string; cached: boolean };
		expect(first).toMatchObject({ name: "Nocturne Op. 9 No. 2", uploader: "Pianist", cached: false });
		expect(first.path).toMatch(/^music\/online\/[0-9a-f]{12}\.m4a$/);
		const download = calls.find((c) => c.includes("-x")) as string[];
		expect(download.join(" ")).toContain("--match-filter !is_live & duration <= 900");
		expect(calls.at(-1)?.join(" ")).toContain("loudnorm=I=-16");
		expect((await fs.readdir(path.join(root, "music", "online"))).sort()).toEqual([path.basename(first.path), path.basename(first.path).replace(".m4a", ".json")].sort());
		const again = (await handleMusic({ kind: "get", source: "online", ref: "https://www.youtube.com/watch?v=a" }, { filesRoot: root, env, runner })).body as { cached: boolean };
		expect(again.cached).toBe(true);
		const local = (await handleMusic({ kind: "search", query: "nocturne", sources: ["library"] }, { filesRoot: root, env, runner })).body as { results: { name: string }[] };
		expect(local.results.map((x) => x.name)).toEqual(["Nocturne Op. 9 No. 2"]);
	});

	test("bad requests", async () => {
		expect((await handleMusic({ kind: "search", query: "!!" }, { filesRoot: root, runner })).status).toBe(400);
		expect((await handleMusic({ kind: "get", source: "online", ref: "file:///x" }, { filesRoot: root, runner })).status).toBe(502);
		expect((await handleMusic({ kind: "search", query: "x", sources: ["spotify"] }, { filesRoot: root, runner })).status).toBe(400);
	});
});
