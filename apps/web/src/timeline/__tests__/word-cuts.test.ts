import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TimelineElement, VideoElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { cutWarnings, findWord, snapCutsToWords, wordEdgeTimes, wordInside } = await import("@/timeline/word-cuts");
const { fieldsMapOf } = await import("@/agent/stale");
const { parseSourceWords } = await import("@/media/words");
const { computeAgentDraft } = await import("@/agent/draft");
const { buildSceneSnapshot } = await import("@/agent/snapshot");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const sec = (ticks: number) => Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000;
// "so the punchline lands", words in source seconds
const words = [
	{ text: "so", start: 1.0, end: 1.2 },
	{ text: "the", start: 1.25, end: 1.4 },
	{ text: "punchline", start: 1.45, end: 2.05 },
	{ text: "lands", start: 2.1, end: 2.5 },
];
const fps = { numerator: 30, denominator: 1 };
const clip = (trimStart: number, duration: number, extra: Record<string, unknown> = {}) =>
	({ id: "v1", agentId: "clip", type: "video", name: "v1", mediaId: "m1", startTime: T(10), duration: T(duration), trimStart: T(trimStart), trimEnd: T(10 - trimStart - duration), sourceDuration: T(10), params: {}, ...extra }) as unknown as VideoElement;
const scenesWith = (elements: TimelineElement[]): TScene[] => [{
	id: "main", name: "main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
	tracks: { main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements }, overlay: [], audio: [] } as unknown as SceneTracks,
} as TScene];
const run = (scenes: TScene[], ops: unknown[], wordsOf = (id: string) => (id === "m1" ? words : undefined)) =>
	computeAgentDraft({ scenes, rootSceneId: "main", ops: ops as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps, ripple: false, wordsOf });
const main = (scenes: TScene[]) => scenes[0].tracks.main.elements[0];

describe("cuts and spoken words", () => {
	const overlappingWords = [
		{ text: "long", start: 0, end: 4 },
		{ text: "later", start: 0.1, end: 3.2 },
		...Array.from({ length: 12 }, (_, index) => ({
			text: `short ${index}`,
			start: 0.25 + index * 0.2,
			end: 0.35 + index * 0.2,
		})),
	];

	test("looks past later short words and prefers the latest containing word", () => {
		expect(wordInside(overlappingWords, 3)?.text).toBe("later");
		expect(wordInside(overlappingWords, 3.4)?.text).toBe("long");
		expect(wordInside(overlappingWords, 3.98)).toBeNull();
		expect(wordInside(overlappingWords, 4.1)).toBeNull();
	});

	test("a draft warns about a long overlapping word and moves the cut outside it on request", () => {
		const scenes = scenesWith([clip(0, 6)]);
		const op = { op: "set", match: { agentId: "clip" }, trimStart: 3.4, duration: 1.6 };
		const plain = run(scenes, [op], () => overlappingWords);
		expect(plain.results[0].cutWarnings).toMatchObject([
			{ edge: "start", at: 3.4, word: { text: "long" } },
		]);
		const snapped = run(scenes, [{ ...op, cut: "words" }], () => overlappingWords);
		expect(snapped.results[0]).toMatchObject({ ok: true });
		expect(main(snapped.scenes).trimStart).toBe(T(0));
		expect(main(snapped.scenes).duration).toBe(T(5));
	});

	test("a draft keeps the exact safe end when both adjacent frame ends cut a word", () => {
		const transcript = [
			{ text: "long", start: 0, end: 4.019 },
			{ text: "first", start: 0, end: 0.5 },
			...Array.from({ length: 8 }, (_, index) => ({
				text: `short ${index}`,
				start: 0.5 + index * 0.4,
				end: 0.6 + index * 0.4,
			})),
			{ text: "middle", start: 3.995, end: 4.038 },
			{ text: "last", start: 4.01, end: 4.2 },
		];
		const out = computeAgentDraft({
			scenes: scenesWith([clip(0, 6)]),
			rootSceneId: "main",
			ops: [{ op: "set", match: { agentId: "clip" }, trimStart: 0.3, duration: 3.69, cut: "words" }],
			mediaFor: () => undefined,
			wordsOf: () => transcript,
			canvas: { width: 1920, height: 1080 },
			fps: { numerator: 60, denominator: 1 },
			ripple: false,
		});
		expect(out.results[0]).toMatchObject({ ok: true });
		expect(out.results[0].cutWarnings).toBeUndefined();
		const after = main(out.scenes);
		expect(after.trimStart).toBe(T(0));
		expect(after.duration).toBe(T(4.019));
	});

	test("a time inside a word is found; the edges and gaps are not", () => {
		expect(wordInside(words, 1.7)?.text).toBe("punchline");
		expect(wordInside(words, 1.46)).toBeNull(); // within the tolerance of its start
		expect(wordInside(words, 2.07)).toBeNull(); // in the gap
		expect(wordInside(words, 0.5)).toBeNull();
	});

	test("a clip whose cuts fall inside words says which", () => {
		expect(cutWarnings(clip(1.1, 0.8), words)).toEqual([
			{ edge: "start", at: 1.1, word: words[0] },
			{ edge: "end", at: 1.9, word: words[2] },
		]);
		expect(cutWarnings(clip(1.0, 1.05), words)).toEqual([]);
	});

	test("snapping moves a start back to its word's start and an end on to its word's end, in whole frames", () => {
		const patch = snapCutsToWords(clip(1.1, 0.8), words, fps)!;
		expect(sec(patch.trimStart)).toBe(1);
		// 1.0 → 2.05 = 1.05 s, rounded up to 32 frames at 30 fps
		expect(sec(patch.duration)).toBe(1.067);
		expect(sec(patch.trimEnd)).toBe(sec(T(10) - patch.trimStart - patch.duration));
		expect(snapCutsToWords(clip(1.0, 1.05), words, fps)).toBeNull();
		// Never past the end of the source.
		const short = snapCutsToWords({ ...clip(1.5, 0.3), sourceDuration: T(1.9) }, words, fps)!;
		expect(sec(short.trimStart + short.duration)).toBeLessThanOrEqual(1.9 + 1 / 30);
	});

	test("word lists are checked and sorted", () => {
		expect(parseSourceWords([{ text: "b", start: 2, end: 3 }, { text: "a", start: 0, end: 1 }])?.map((w) => w.text)).toEqual(["a", "b"]);
		expect(parseSourceWords([{ text: "x", start: 2, end: 1 }])).toBeNull();
		expect(parseSourceWords("nope")).toBeNull();
	});
});

describe("drafts", () => {
	test('cut: "words" on a set moves the cuts out of words; without it the result warns', () => {
		const scenes = scenesWith([clip(0, 5)]);
		const cut = run(scenes, [{ op: "set", match: { agentId: "clip" }, trimStart: 1.1, duration: 0.8, cut: "words" }]);
		expect(cut.results[0]).toMatchObject({ ok: true });
		expect(cut.results[0].cutWarnings).toBeUndefined();
		expect(sec(main(cut.scenes).trimStart)).toBe(1);
		expect(sec(main(cut.scenes).startTime)).toBe(10);
		const plain = run(scenes, [{ op: "set", match: { agentId: "clip" }, trimStart: 1.1, duration: 0.8 }]);
		expect(plain.results[0].cutWarnings.map((w: { edge: string; word: { text: string } }) => [w.edge, w.word.text])).toEqual([["start", "so"], ["end", "punchline"]]);
	});

	test("a words op attaches words a later op of the same draft uses; bad input fails the op", () => {
		const scenes = scenesWith([clip(0, 5, { mediaId: "m2" })]);
		const out = run(scenes, [
			{ op: "words", mediaId: "m2", words },
			{ op: "set", match: { agentId: "clip" }, trimStart: 1.1, duration: 0.8, cut: "words" },
		]);
		expect(out.results.map((r) => r.ok)).toEqual([true, true]);
		expect(out.words.get("m2")).toEqual(words);
		expect(sec(main(out.scenes).trimStart)).toBe(1);
		expect(run(scenes, [{ op: "words", mediaId: "m2", words: [{ text: "x" }] }]).results[0]).toMatchObject({ ok: false });
		expect(run(scenes, [{ op: "set", match: { agentId: "clip" }, duration: 1, cut: "words" }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("needs the media") });
		expect(run(scenes, [{ op: "set", match: { agentId: "clip" }, duration: 1, cut: "frames" }]).results[0]).toMatchObject({ ok: false });
	});

	test("the snapshot lists cuts inside words for clips whose media have words", () => {
		const snapshot = buildSceneSnapshot({ scenes: scenesWith([clip(1.1, 0.8)]), rootSceneId: "main", mediaName: new Map(), wordsOf: (id) => (id === "m1" ? words : undefined) });
		expect(snapshot.tracks.find((t) => t.group === "main")?.elements[0]).toMatchObject({ cutWarnings: [{ edge: "start" }, { edge: "end" }] });
		const without = buildSceneSnapshot({ scenes: scenesWith([clip(1.1, 0.8)]), rootSceneId: "main", mediaName: new Map() });
		expect("cutWarnings" in (without.tracks.find((t) => t.group === "main")?.elements[0] ?? {})).toBe(false);
	});
});

describe("words stored with media", () => {
	test("saved in the media metadata and read back (checked) when the project loads", async () => {
		const { StorageService } = await import("@/services/storage/service");
		const posted: Record<string, unknown>[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
			if (/\/media$/.test(String(url))) return new Response(JSON.stringify([{ id: "m1", name: "m1", type: "audio", words: [{ text: "b", start: 2, end: 3 }, { text: "a", start: 0, end: 1 }] }, { id: "m2", name: "m2", type: "audio", words: "broken" }]));
			if (init?.method === "POST") {
				posted.push(JSON.parse(init.body ?? "{}"));
				return new Response("{}");
			}
			if (init?.method === "PUT") return new Response("{}");
			return new Response(new Blob(["x"]));
		}) as typeof fetch;
		try {
			const storage = new StorageService();
			await storage.saveMediaAsset({ projectId: "p", mediaAsset: { id: "m1", name: "m1", type: "audio", file: new File(["x"], "m1.wav"), words } as never });
			expect(posted.at(-1)).toMatchObject({ id: "m1", words });
			const loaded = await storage.loadAllMediaAssets({ projectId: "p" });
			expect(loaded.find((a) => a.id === "m1")?.words?.map((w) => w.text)).toEqual(["a", "b"]);
			expect(loaded.find((a) => a.id === "m2")?.words).toBeUndefined();
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("review fixes", () => {
	const ntsc = { numerator: 30000, denominator: 1001 };
	test("rounding to frames never reaches into the next word or past the source", () => {
		const tight = [{ text: "a", start: 0.5, end: 1.013 }, { text: "b", start: 1.014, end: 1.4 }];
		const patch = snapCutsToWords(clip(0.6, 0.3), tight, ntsc)!;
		const end = sec(patch.trimStart + patch.duration);
		expect(end).toBeGreaterThanOrEqual(1.013 - 0.02);
		expect(wordInside(tight, (patch.trimStart + patch.duration) / TICKS_PER_SECOND)).toBeNull();
		const atEof = snapCutsToWords({ ...clip(0.6, 0.3), sourceDuration: T(1.013) }, tight, ntsc)!;
		expect((atEof.trimStart + atEof.duration) / TICKS_PER_SECOND).toBeLessThanOrEqual(1.013 + 1e-6);
	});

	test("a retimed clip plays duration × rate of its source", () => {
		const fast = clip(1, 1, { retime: { rate: 2 } });
		expect(cutWarnings(fast, [{ text: "late", start: 2.8, end: 3.3 }])).toMatchObject([{ edge: "end", at: 3 }]);
		const patch = snapCutsToWords(fast, [{ text: "late", start: 2.8, end: 3.3 }], fps)!;
		// 1 s of source → 2.3 s plays in 1.15 s at 2x, rounded up to whole frames
		expect(sec(patch.duration)).toBeCloseTo(1.167, 2);
	});

	test("overlapping words are found; a clip without sourceDuration never runs past what its trims leave", () => {
		expect(wordInside([{ text: "long", start: 1, end: 2 }, { text: "short", start: 1.3, end: 1.4 }], 1.7)?.text).toBe("long");
		const legacy = { trimStart: T(0), duration: T(0.9), trimEnd: T(0.113) } as never;
		const patch = snapCutsToWords(legacy, [{ text: "w", start: 0.5, end: 1.5 }], fps)!;
		expect((patch.trimStart + patch.duration) / TICKS_PER_SECOND).toBeLessThanOrEqual(1.013 + 1e-6);
	});

	test("word snap marks for resizing are rounded outwards to whole frames", () => {
		const film = { numerator: 24, denominator: 1 };
		const [right] = wordEdgeTimes({ clip: clip(0, 3), startTime: T(0), words: [{ text: "w", start: 1, end: 2.0205 }], side: "right", fps: film });
		expect(right / TICKS_PER_SECOND).toBeGreaterThanOrEqual(2.0205);
		const [left] = wordEdgeTimes({ clip: clip(0, 3), startTime: T(0), words: [{ text: "w", start: 1.0205, end: 2 }], side: "left", fps: film });
		expect(left / TICKS_PER_SECOND).toBeLessThanOrEqual(1.0205);
	});

	test("snapping that would run into the next clip fails, with or without ripple (ripple only closes gaps)", () => {
		// The clip ends (10.8 s) where the next one starts; its end cuts "punchline", which ends 0.15 s later.
		const next = { ...clip(5, 2), id: "v2", agentId: "next", startTime: T(10.8) } as unknown as VideoElement;
		const scenes = scenesWith([clip(1.1, 0.8), next]);
		const set = [{ op: "set", match: { agentId: "clip" }, cut: "words" }];
		expect(run(scenes, set).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("overlap") });
		const rippled = computeAgentDraft({ scenes, rootSceneId: "main", ops: set as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps, ripple: true, wordsOf: (id) => (id === "m1" ? words : undefined) });
		expect(rippled.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("overlap") });
		const [first, second] = rippled.scenes[0].tracks.main.elements;
		expect(second.startTime).toBeGreaterThanOrEqual(first.startTime + first.duration);
		// With room after it, the same op applies.
		const roomy = run(scenesWith([clip(1.1, 0.8), { ...next, startTime: T(12) } as VideoElement]), set);
		expect(roomy.results[0]).toMatchObject({ ok: true });
	});

	test("basedOn: a cut:\"words\" set counts as touching trimStart and duration", () => {
		const snapshot = scenesWith([clip(0, 5)]);
		const moved = scenesWith([clip(0.8, 4.2)]);
		const out = computeAgentDraft({ scenes: moved, rootSceneId: "main", ops: [{ op: "set", match: { agentId: "clip" }, cut: "words" }] as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps, ripple: false, wordsOf: () => words, base: fieldsMapOf(snapshot) });
		expect(out.results[0]).toMatchObject({ ok: false, stale: true });
	});

	test("an add after a words op of the same draft uses the new words; cut inside a compound or a replace is refused", () => {
		const fresh = [{ text: "x", start: 0.5, end: 1.1 }];
		const loaded = { id: "m1", type: "video" as const, duration: 10, words: [{ text: "x", start: 0.5, end: 0.9 }] };
		const ops = [
			{ op: "words", mediaId: "m1", words: fresh },
			{ op: "add", track: { name: "Main" }, element: { agent_id: "new", name: "new", mediaId: "m1", start: 20, duration: 0.3, trimStart: 0.6, cut: "words" } },
		];
		const out = computeAgentDraft({ scenes: scenesWith([]), rootSceneId: "main", ops: ops as never, mediaFor: () => loaded, canvas: { width: 1920, height: 1080 }, fps, ripple: false });
		expect(out.results.map((r) => r.ok)).toEqual([true, true]);
		const added = out.scenes[0].tracks.main.elements[0];
		expect((added.trimStart + added.duration) / TICKS_PER_SECOND).toBeGreaterThanOrEqual(1.1 - 0.02);
		const nested = run(scenesWith([]), [{ op: "compound", name: "c", start: 0, main: [{ name: "x", mediaId: "m1", start: 0, duration: 1, cut: "words" }] }]);
		expect(nested.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("top-level") });
		const replaced = run(scenesWith([clip(0, 5)]), [{ op: "replace", match: { agentId: "clip" }, element: { name: "y", mediaId: "m1", start: 10, duration: 1, cut: "words" } }]);
		expect(replaced.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("top-level") });
	});
});

describe("review round 2", () => {
	test("a start moved out of one word that lands inside an overlapping word moves on until it is out of all", () => {
		const overlapping = [{ text: "a", start: 0.8, end: 1.3 }, { text: "b", start: 1.0, end: 1.6 }];
		const patch = snapCutsToWords(clip(1.2, 0.6), overlapping, fps)!;
		expect(sec(patch.trimStart)).toBe(0.8);
	});

	test("shortening a legacy clip (no sourceDuration) does not shorten what its file can play", () => {
		const legacy = { ...clip(0, 2), sourceDuration: undefined, trimEnd: T(0) } as unknown as VideoElement;
		const out = run(scenesWith([legacy]), [{ op: "set", match: { agentId: "clip" }, duration: 1.2, cut: "words" }], () => [{ text: "w", start: 0.5, end: 1.5 }]);
		expect(out.results[0]).toMatchObject({ ok: true });
		const after = main(out.scenes);
		expect((after.trimStart + after.duration) / TICKS_PER_SECOND).toBeGreaterThanOrEqual(1.5 - 0.02);
	});

	test("resize marks are the edge plus whole frames (off the frame grid too) and never inside a word", () => {
		const film = { numerator: 24, denominator: 1 };
		const offGrid = { ...clip(0, 3), startTime: T(0.01) } as unknown as VideoElement;
		const frameTicks = TICKS_PER_SECOND / 24;
		const close = [{ text: "w", start: 1, end: 2.0205 }, { text: "next", start: 2.03, end: 2.5 }];
		for (const mark of wordEdgeTimes({ clip: offGrid, startTime: offGrid.startTime, words: close, side: "right", fps: film })) {
			const steps = (mark - (offGrid.startTime + offGrid.duration)) / frameTicks;
			expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
			expect(wordInside(close, (mark - offGrid.startTime) / TICKS_PER_SECOND)).toBeNull();
		}
	});
});

describe("review round 3", () => {
	test("many overlapping words: the start still ends up outside all of them", () => {
		const chain = Array.from({ length: 18 }, (_, i) => ({ text: `w${i}`, start: 1 + i * 0.1, end: 1.25 + i * 0.1 }));
		const patch = snapCutsToWords(clip(2.6, 0.5), chain, fps)!;
		expect(wordInside(chain, patch.trimStart / TICKS_PER_SECOND)).toBeNull();
	});

	test("a short retimed cut near the end of the source never runs past it", () => {
		const fast = { ...clip(9.9, 0.02, { retime: { rate: 2 } }), sourceDuration: T(9.95) } as unknown as VideoElement;
		const patch = snapCutsToWords(fast, [{ text: "end", start: 9.85, end: 10.2 }], fps)!;
		const played = (patch.duration / TICKS_PER_SECOND) * 2;
		expect(patch.trimStart / TICKS_PER_SECOND + played).toBeLessThanOrEqual(9.95 + 1e-6);
	});

	test("cut on an add that builds a text (a mediaId does not make it a clip) fails", () => {
		const loaded = { id: "m1", type: "video" as const, duration: 10, words };
		const out = computeAgentDraft({ scenes: scenesWith([]), rootSceneId: "main", ops: [{ op: "add", track: { name: "Captions", type: "text" }, element: { name: "t", text: "hi", mediaId: "m1", start: 0, duration: 1, cut: "words" } }] as never, mediaFor: () => loaded, canvas: { width: 1920, height: 1080 }, fps, ripple: false });
		expect(out.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("video and audio") });
	});
});

describe("cuts at named words", () => {
	test("a word is found by its text (case and punctuation aside), its occurrence, from the clip's start", () => {
		const repeated = [...words, { text: "Punchline!", start: 3, end: 3.5 }];
		expect(findWord(repeated, "PUNCHLINE", 0)).toMatchObject({ start: 1.45 });
		expect(findWord(repeated, { text: "punchline", occurrence: 2 }, 0)).toMatchObject({ start: 3 });
		expect(findWord(repeated, "punchline", 2.5)).toMatchObject({ start: 3 });
		expect(findWord(repeated, "nope", 0)).toContain('no "nope"');
		expect(findWord(repeated, { text: "so", occurrence: 0 }, 0)).toContain("occurrence");
	});

	test("end the clip after the punchline word: within one frame of its end, no word cut", () => {
		const out = run(scenesWith([clip(0.9, 3)]), [{ op: "set", match: { agentId: "clip" }, endAfterWord: "punchline" }]);
		expect(out.results[0]).toMatchObject({ ok: true, endWord: { text: "punchline", end: 2.05 } });
		const after = main(out.scenes);
		const end = (after.trimStart + after.duration) / TICKS_PER_SECOND;
		expect(end).toBeGreaterThanOrEqual(2.05 - 0.02);
		expect(end - 2.05).toBeLessThanOrEqual(1 / 30 + 1e-6);
		expect(wordInside(words, end)).toBeNull();
		expect(out.results[0].cutWarnings).toBeUndefined();
	});

	test("start at a word and end after another; mixing with explicit timing is refused; adds take them too", () => {
		const both = run(scenesWith([clip(0, 5)]), [{ op: "set", match: { agentId: "clip" }, startAtWord: "the", endAfterWord: "lands" }]);
		expect(both.results[0]).toMatchObject({ ok: true, startWord: { text: "the" }, endWord: { text: "lands" } });
		expect(sec(main(both.scenes).trimStart)).toBe(1.25);
		expect(run(scenesWith([clip(0, 5)]), [{ op: "set", match: { agentId: "clip" }, duration: 1, endAfterWord: "lands" }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("replace trimStart") });
		expect(run(scenesWith([clip(0, 5)]), [{ op: "set", match: { agentId: "clip" }, startAtWord: "lands", endAfterWord: "so" }]).results[0]).toMatchObject({ ok: false });
		const loaded = { id: "m1", type: "video" as const, duration: 10, words };
		const added = computeAgentDraft({ scenes: scenesWith([]), rootSceneId: "main", ops: [{ op: "add", track: { name: "Main" }, element: { agent_id: "n", name: "n", mediaId: "m1", start: 20, startAtWord: "so", endAfterWord: "punchline" } }] as never, mediaFor: () => loaded, canvas: { width: 1920, height: 1080 }, fps, ripple: false });
		expect(added.results[0]).toMatchObject({ ok: true, startWord: { text: "so" }, endWord: { text: "punchline" } });
	});

	test("with basedOn, a named-word cut counts as touching trimStart and duration", () => {
		const out = computeAgentDraft({ scenes: scenesWith([clip(0.8, 4)]), rootSceneId: "main", ops: [{ op: "set", match: { agentId: "clip" }, endAfterWord: "lands" }] as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps, ripple: false, wordsOf: () => words, base: fieldsMapOf(scenesWith([clip(0, 5)])) });
		expect(out.results[0]).toMatchObject({ ok: false, stale: true });
	});
});

describe("cuts at named words: review fixes", () => {
	const loaded = { id: "m1", type: "video" as const, duration: 10, words };
	const add = (scenes: TScene[], element: Record<string, unknown>) =>
		computeAgentDraft({ scenes, rootSceneId: "main", ops: [{ op: "add", track: { name: "Main" }, element: { agent_id: "n", name: "n", mediaId: "m1", ...element } }] as never, mediaFor: () => loaded, canvas: { width: 1920, height: 1080 }, fps, ripple: false });

	test("an add cut at its words never overlaps a clip on its track", () => {
		const occupied = scenesWith([{ ...clip(0, 2), id: "busy", agentId: "busy", startTime: T(20.5) } as unknown as VideoElement]);
		expect(add(occupied, { start: 20, endAfterWord: "lands" }).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("overlap") });
	});

	test("a named word must play: one past the end of the media fails", () => {
		const late = [...words, { text: "after", start: 10.1, end: 10.5 }];
		const out = computeAgentDraft({ scenes: scenesWith([clip(0, 5)]), rootSceneId: "main", ops: [{ op: "set", match: { agentId: "clip" }, endAfterWord: "after" }] as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps, ripple: false, wordsOf: () => late });
		expect(out.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("past the end") });
	});

	test("on an add a named start replaces trimStart and a named end replaces duration", () => {
		expect(add(scenesWith([]), { start: 20, trimStart: 1, startAtWord: "so" }).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("replaces trimStart") });
		expect(add(scenesWith([]), { start: 20, duration: 3, endAfterWord: "lands" }).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("replaces duration") });
	});

	test("matching: punctuation around a word does not count, inside it does; a word just before the start does not count", () => {
		const spoken = [{ text: "nggak,", start: 1.0, end: 1.2 }, { text: "Nggak?", start: 1.5, end: 1.7 }, { text: "3,5", start: 2, end: 2.4 }, { text: "😂", start: 3, end: 3.2 }];
		expect(findWord(spoken, "nggak", 1.015)).toMatchObject({ start: 1.5 });
		expect(findWord(spoken, "3,5", 0)).toMatchObject({ start: 2 });
		expect(typeof findWord(spoken, "35", 0)).toBe("string");
		expect(findWord(spoken, "😂", 0)).toMatchObject({ start: 3 });
	});

	test("a one-frame minimum never reaches into the next word", () => {
		const tight = [{ text: "a", start: 1, end: 1.04 }, { text: "b", start: 1.04, end: 1.5 }];
		const fast = clip(0.9, 1, { retime: { rate: 2 } });
		const out = computeAgentDraft({ scenes: scenesWith([fast]), rootSceneId: "main", ops: [{ op: "set", match: { agentId: "clip" }, startAtWord: "a", endAfterWord: "a" }] as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps, ripple: false, wordsOf: () => tight });
		expect(out.results[0]).toMatchObject({ ok: true });
		const after = main(out.scenes);
		const end = after.trimStart / TICKS_PER_SECOND + (after.duration / TICKS_PER_SECOND) * 2;
		expect(wordInside(tight, end)).toBeNull();
	});
});
