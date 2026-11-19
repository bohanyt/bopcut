import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TextElement, TimelineElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { computeAgentDraft } = await import("./draft");
const { SnapshotHistory, fieldsMapOf } = await import("./stale");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const text = (id: string, agentId: string, params: Record<string, unknown>) =>
	({ id, agentId, type: "text", name: id, startTime: T(0), duration: T(3), trimStart: T(0), trimEnd: T(0), params: { content: id, ...params } }) as unknown as TextElement;
const scenesWith = (elements: TimelineElement[]): TScene[] => [
	{
		id: "main", name: "main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
		tracks: { main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, overlay: [{ id: "t-text", name: "Captions", type: "text", hidden: false, elements: elements as TextElement[] }], audio: [] } as unknown as SceneTracks,
	} as TScene,
];
const run = (scenes: TScene[], ops: any[], base?: Map<string, any>) =>
	computeAgentDraft({ scenes, rootSceneId: "main", ops, mediaFor: () => undefined, canvas: { width: 1080, height: 1920 }, fps: { numerator: 30, denominator: 1 }, ripple: false, base });
const paramOf = (scenes: TScene[], id: string, key: string) => (scenes[0].tracks.overlay[0].elements.find((e) => e.id === id) as TimelineElement).params[key];

describe("editing on top of the user's edits (basedOn)", () => {
	// The agent read this snapshot; afterwards the user changed a1's color and moved a2.
	const read = scenesWith([text("a1", "cap-1", { color: "#ffffff", fontSize: 4 }), text("a2", "cap-2", { color: "#ffffff" })]);
	const base = fieldsMapOf(read);
	const now = scenesWith([text("a1", "cap-1", { color: "#ff0000", fontSize: 4 }), { ...text("a2", "cap-2", { color: "#ffffff" }), startTime: T(1) } as TimelineElement]);

	test("a field the user did not touch still applies on an element the user edited", () => {
		const out = run(now, [{ op: "set", match: { agentId: "cap-1" }, params: { fontSize: 6 } }], base);
		expect(out.results[0]).toMatchObject({ ok: true });
		expect(paramOf(out.scenes, "a1", "fontSize")).toBe(6);
		expect(paramOf(out.scenes, "a1", "color")).toBe("#ff0000");
	});

	test("a field the user changed after basedOn is refused as stale, with the current value", () => {
		const out = run(now, [{ op: "set", match: { agentId: "cap-1" }, params: { color: "#ffff00", fontSize: 5 } }], base);
		expect(out.results[0]).toMatchObject({ ok: false, stale: true, fields: ["params.color"], current: { "params.color": "#ff0000" } });
		expect(paramOf(out.scenes, "a1", "color")).toBe("#ff0000");
		expect(paramOf(out.scenes, "a1", "fontSize")).toBe(4);
	});

	test("timing changes count too, and delete is refused when the element changed at all", () => {
		const move = run(now, [{ op: "set", match: { agentId: "cap-2" }, start: 2 }], base);
		expect(move.results[0]).toMatchObject({ ok: false, stale: true, fields: ["start"], current: { start: 1 } });
		const del = run(now, [{ op: "delete", match: { agentId: "cap-2" } }], base);
		expect(del.results[0]).toMatchObject({ ok: false, stale: true });
		const untouched = run(now, [{ op: "delete", match: { agentId: "cap-1" } }], fieldsMapOf(now));
		expect(untouched.results[0]).toMatchObject({ ok: true });
	});

	test("one stale op does not block the others; without basedOn nothing is checked", () => {
		const out = run(now, [{ op: "set", match: { agentId: "cap-1" }, params: { color: "#00ff00" } }, { op: "set", match: { agentId: "cap-2" }, params: { color: "#00ff00" } }], base);
		expect(out.results.map((r) => r.ok)).toEqual([false, true]);
		const legacy = run(now, [{ op: "set", match: { agentId: "cap-1" }, params: { color: "#00ff00" } }]);
		expect(legacy.results[0].ok).toBe(true);
	});

	test("history keeps recent snapshots by syncedAt", () => {
		const history = new SnapshotHistory(2);
		history.record("t1", read);
		history.record("t2", now);
		history.record("t3", now);
		expect(history.get("t1")).toBeUndefined();
		expect(history.get("t3")?.get("main:a1")?.params.color).toBe(JSON.stringify("#ff0000"));
	});
});
