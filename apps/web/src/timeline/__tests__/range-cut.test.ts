import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TimelineElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { cutRange, cutRangeBookmarks } = await import("@/timeline/range-cut");
const { computeAgentDraft } = await import("@/agent/draft");
const { fieldsMapOf } = await import("@/agent/stale");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const s = (ticks: number) => Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000;
const el = (id: string, type: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
	({ id, agentId: id, type, name: id, mediaId: `m-${id}`, startTime: T(start), duration: T(duration), trimStart: T(0), trimEnd: T(10), sourceDuration: T(duration + 10), params: {}, ...extra }) as unknown as TimelineElement;
const tracks = (): SceneTracks => ({
	main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: [el("A", "video", 0, 2), el("B", "video", 2, 4), el("C", "video", 6, 2)] },
	overlay: [{ id: "t-text", name: "Captions", type: "text", hidden: false, elements: [el("T", "text", 3, 1), el("D", "text", 4, 3)] }],
	audio: [{ id: "t-audio", name: "Music", type: "audio", muted: false, elements: [el("S", "audio", 0, 8)] }],
}) as unknown as SceneTracks;
let n = 0;
const newId = () => `new-${++n}`;
const spans = (elements: TimelineElement[]) => elements.map((e) => [e.id, s(e.startTime), s(e.duration), s(e.trimStart)]);

describe("cutting a range out of every track", () => {
	test("clips across the range are split, what plays inside is dropped, the rest moves up", () => {
		n = 0;
		const out = cutRange({ tracks: tracks(), start: T(3), end: T(5), newId });
		expect(spans(out.tracks.main.elements)).toEqual([["A", 0, 2, 0], ["B", 2, 1, 0], ["new-1", 3, 1, 3], ["C", 4, 2, 0]]);
		// T (3–4) is inside the range; D (4–7) starts inside and keeps its id.
		expect(spans(out.tracks.overlay[0].elements)).toEqual([["D", 3, 2, 1]]);
		expect(spans(out.tracks.audio[0].elements)).toEqual([["S", 0, 3, 0], ["new-2", 3, 3, 5]]);
		expect(out.removed.map((e) => e.id)).toEqual(["T"]);
		expect(out.trimmed.map((e) => e.id).sort()).toEqual(["B", "D", "S"]);
		expect(out.shifted.map((e) => e.id)).toEqual(["C"]);
	});

	test("notes after the range move up; notes inside it move to the cut", () => {
		const frame = T(1 / 30);
		const notes = [{ time: T(1) }, { time: T(4) }, { time: T(4.5) }, { time: T(6) }, { time: T(1), duration: T(5) }] as never;
		const moved = cutRangeBookmarks(notes, T(3), T(5), frame) as { time: number; duration?: number }[];
		// Two notes inside the cut do not share a time; a note's span follows the timeline.
		expect(moved.map((b) => s(b.time))).toEqual([1, 3, s(T(3) + frame), 4, 1]);
		expect(s(moved[4].duration!)).toBe(3);
	});
});

describe("the cut draft op", () => {
	const scenes = (): TScene[] => [{ id: "main", name: "main", isMain: true, bookmarks: [{ time: T(6), note: "x" }], createdAt: new Date(0), updatedAt: new Date(0), tracks: tracks() } as unknown as TScene];
	const run = (ops: unknown[], extra: Record<string, unknown> = {}) =>
		computeAgentDraft({ scenes: scenes(), rootSceneId: "main", ops: ops as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps: { numerator: 30, denominator: 1 }, ripple: false, ...extra });

	test("reports what it removed, trimmed and moved, and keeps notes in step", () => {
		const out = run([{ op: "cut", start: 3, end: 5 }]);
		expect(out.results[0]).toMatchObject({ ok: true, removed: 1, trimmed: 3, shifted: 1 });
		expect(s(out.scenes[0].bookmarks[0].time)).toBe(4);
		expect(out.results[0].kept.length).toBe(5);
	});

	test("an invalid range fails; with basedOn, a clip the user edited is not cut away", () => {
		expect(run([{ op: "cut", start: 5, end: 3 }]).results[0]).toMatchObject({ ok: false });
		expect(run([{ op: "cut", start: -1, end: 3 }]).results[0]).toMatchObject({ ok: false });
		const edited = scenes();
		edited[0] = { ...edited[0], tracks: { ...edited[0].tracks, overlay: [{ ...edited[0].tracks.overlay[0], elements: [el("T", "text", 3, 1, { params: { content: "fixed" } }), el("D", "text", 4, 3)] }] } as never };
		const out = computeAgentDraft({ scenes: edited, rootSceneId: "main", ops: [{ op: "cut", start: 3, end: 5 }] as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps: { numerator: 30, denominator: 1 }, ripple: false, base: fieldsMapOf(scenes()) });
		expect(out.results[0]).toMatchObject({ ok: false, stale: true });
	});

	test("kept parts whose cut falls inside a word are warned about", () => {
		const out = run([{ op: "cut", start: 3, end: 5 }], { wordsOf: (id: string) => (id === "m-S" ? [{ text: "mid", start: 2.9, end: 3.4 }] : undefined) });
		expect(out.results[0].cutWarnings).toMatchObject([{ edge: "end", word: { text: "mid" } }]);
	});
});

describe("range cut review fixes", () => {
	const scenes = (): TScene[] => [{ id: "main", name: "main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0), tracks: tracks() } as unknown as TScene];
	const run = (ops: unknown[], extra: Record<string, unknown> = {}) =>
		computeAgentDraft({ scenes: scenes(), rootSceneId: "main", ops: ops as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps: { numerator: 30, denominator: 1 }, ripple: false, ...extra });

	test("a range shorter than a frame fails; a range is put on whole frames (start up, end down)", () => {
		expect(run([{ op: "cut", start: 0.3, end: 0.1 + 0.2 }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("shorter than a frame") });
		const out = run([{ op: "cut", start: 2.01, end: 4.99 }]);
		const { start, end } = out.results[0];
		expect(out.results[0].ok).toBe(true);
		expect(start).toBeGreaterThanOrEqual(2.01);
		expect(end).toBeLessThanOrEqual(4.99);
		expect(Math.abs(start * 30 - Math.round(start * 30))).toBeLessThan(1e-6);
		expect(Math.abs(end * 30 - Math.round(end * 30))).toBeLessThan(1e-6);
	});

	test("a clip across the whole range: the part after it gets its own agentId", () => {
		const out = run([{ op: "cut", start: 3, end: 5 }]);
		const main = out.scenes[0].tracks.main.elements;
		expect(main.filter((e) => e.agentId === "B").length).toBe(1);
		expect(main.some((e) => e.agentId === "B~after")).toBe(true);
	});

	test("with basedOn, a clip the user changed in any way (a fade) is not trimmed", () => {
		const edited = scenes();
		edited[0] = { ...edited[0], tracks: { ...edited[0].tracks, main: { ...edited[0].tracks.main, elements: [el("A", "video", 0, 2), el("B", "video", 2, 4, { params: { fadeOut: 0.5 } }), el("C", "video", 6, 2)] } } as never };
		const out = computeAgentDraft({ scenes: edited, rootSceneId: "main", ops: [{ op: "cut", start: 3, end: 5 }] as never, mediaFor: () => undefined, canvas: { width: 1920, height: 1080 }, fps: { numerator: 30, denominator: 1 }, ripple: false, base: fieldsMapOf(scenes()) });
		expect(out.results[0]).toMatchObject({ ok: false, stale: true });
	});
});
