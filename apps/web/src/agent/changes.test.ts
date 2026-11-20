import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TextElement, VideoElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { changesBetween, changesResult } = await import("./changes");
const { draftHistory, snapshotHistory } = await import("./history");
const { framesStates } = await import("./frames");
const { diffEdits } = await import("./edit-log");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const clip = (trimStart: number) =>
	({ id: "v1", type: "video", name: "v1", mediaId: "m1", startTime: T(0), duration: T(4), trimStart: T(trimStart), trimEnd: T(0), sourceDuration: T(10), params: {} }) as unknown as VideoElement;
const caption = (content: string, agentId?: string) =>
	({ id: "c1", ...(agentId ? { agentId } : {}), type: "text", name: "c1", startTime: T(0), duration: T(2), trimStart: T(0), trimEnd: T(0), params: { content } }) as unknown as TextElement;
const timeline = (elements: { video?: VideoElement[]; text?: TextElement[] }): TScene[] => [
	{
		id: "main", name: "main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
		tracks: {
			main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: elements.video ?? [] },
			overlay: [{ id: "t-text", name: "Captions", type: "text", hidden: false, elements: elements.text ?? [] }],
			audio: [],
		} as unknown as SceneTracks,
	} as TScene,
];
const state = (scenes: TScene[], projectId = "p") => ({ projectId, scenes, rootSceneId: "main" });
const media = new Map([["m1", "interview.mp4"]]);

describe("changes between two timeline states", () => {
	test("a trim and a rewritten caption are listed with their old and new values", () => {
		const before = state(timeline({ video: [clip(0)], text: [caption("Helo", "cap-1")] }));
		const after = state(timeline({ video: [clip(1.5)], text: [caption("Hello", "cap-1")] }));
		const changes = changesBetween({ before, after, mediaName: media });
		// Overlays first, then the main track (top to bottom, as in the timeline).
		expect(changes.map((c) => [c.elementId, c.field, c.from, c.to])).toEqual([
			["c1", "content", "Helo", "Hello"],
			["v1", "trimStart", 0, 1.5],
		]);
		expect(changes.find((c) => c.elementId === "v1")).toMatchObject({ kind: "set", name: "interview.mp4", agentMade: false, track: "Main" });
		expect(changes.find((c) => c.elementId === "c1")).toMatchObject({ agentMade: true, agentId: "cap-1" });
		expect(changes.every((c) => !("actor" in c) && !("t" in c))).toBe(true);
	});

	test("added and deleted items are included, the user's own ones too", () => {
		const before = state(timeline({ video: [clip(0)] }));
		const after = state(timeline({ text: [caption("New")] }));
		const changes = changesBetween({ before, after, mediaName: media });
		expect(changes.map((c) => [c.kind, c.elementId, c.agentMade])).toEqual([["delete", "v1", false], ["add", "c1", false]]);
	});

	test("the edit log also logs elements the user made, marked agentMade:false", () => {
		const item = { id: "u1", agentId: null, name: "u1", media: null, type: "text", track: "Captions", sceneId: "main", path: [], startTime: 0, duration: 1, trimStart: 0, trimEnd: 0, params: {}, animations: {} };
		const deleted = diffEdits({ projectId: "p", items: [item] }, { projectId: "p", items: [] });
		expect(deleted).toMatchObject([{ kind: "delete", elementId: "u1", agentMade: false }]);
		const copied = diffEdits({ projectId: "p", items: [] }, { projectId: "p", items: [{ ...item, agentId: "cap-9" }] });
		expect(copied).toMatchObject([{ kind: "add", agentId: "cap-9", agentMade: true }]);
	});
});

describe("changes requests", () => {
	test("since a snapshot: what changed after it, and the answer is itself a snapshot to chain from", () => {
		snapshotHistory.record("s-1", timeline({ video: [clip(0)] }), { projectId: "p", rootSceneId: "main" });
		const now = state(timeline({ video: [clip(2)] }));
		const result = changesResult({ rev: "q1", since: "s-1" }, { now, mediaName: media, at: "s-2" });
		expect(result).toMatchObject({ rev: "q1", projectId: "p", since: "s-1", syncedAt: "s-2" });
		expect((result as { changes: { field: string }[] }).changes.map((c) => c.field)).toEqual(["trimStart"]);
		expect(snapshotHistory.state("s-2")?.scenes).toBe(now.scenes);
		const nothing = changesResult({ rev: "q2", since: "s-2" }, { now, mediaName: media, at: "s-3" });
		expect((nothing as { changes: unknown[] }).changes).toEqual([]);
	});

	test("for a draft: what the draft changed, and what changed after it", () => {
		const before = state(timeline({ text: [caption("Helo", "cap-1")] }));
		const drafted = state(timeline({ text: [caption("Hello!", "cap-1")] }));
		draftHistory.record("d-1", before, drafted);
		const now = state(timeline({ text: [caption("Hello", "cap-1")] }));
		const result = changesResult({ rev: "q3", draft: "d-1" }, { now, mediaName: media }) as { draftChanges: { from: unknown; to: unknown }[]; changes: { from: unknown; to: unknown }[] };
		expect(result.draftChanges.map((c) => [c.from, c.to])).toEqual([["Helo", "Hello!"]]);
		expect(result.changes.map((c) => [c.from, c.to])).toEqual([["Hello!", "Hello"]]);
	});

	test("unknown snapshots and drafts, other projects and empty requests say why", () => {
		const now = state(timeline({}));
		expect(changesResult({ rev: "q4", since: "never" }, { now, mediaName: media })).toMatchObject({ error: expect.stringContaining("unknown syncedAt") });
		expect(changesResult({ rev: "q5", draft: "never" }, { now, mediaName: media })).toMatchObject({ error: expect.stringContaining("unknown draft") });
		snapshotHistory.record("other-1", timeline({}), { projectId: "other", rootSceneId: "main" });
		expect(changesResult({ rev: "q6", since: "other-1" }, { now, mediaName: media })).toMatchObject({ error: expect.stringContaining("another project") });
		expect(changesResult({ rev: "q7" }, { now, mediaName: media })).toMatchObject({ error: expect.stringContaining("needs since") });
	});
});

describe("frames of a past state", () => {
	test("state and compare resolve to remembered states; malformed or unknown ones are refused with a reason", () => {
		const before = state(timeline({ video: [clip(0)] }));
		const after = state(timeline({ video: [clip(1)] }));
		draftHistory.record("d-2", before, after);
		snapshotHistory.record("s-9", before.scenes, { projectId: "p", rootSceneId: "main" });
		const pair = framesStates({ compare: { draft: "d-2", side: "before" } }, "p");
		expect(pair).toMatchObject({ state: null });
		expect(typeof pair !== "string" && pair.compare?.scenes).toBe(before.scenes);
		const past = framesStates({ state: { syncedAt: "s-9" } }, "p");
		expect(typeof past !== "string" && past.state?.scenes).toBe(before.scenes);
		expect(framesStates({ state: { draft: "d-2" } }, "p")).toContain("state must be");
		expect(framesStates({ compare: { syncedAt: "missing" } }, "p")).toContain("unknown syncedAt");
		expect(framesStates({}, "p")).toEqual({ state: null, compare: null });
	});
});

