import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TimelineElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { computeAgentDraft } = await import("./draft");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const s = (ticks: number) => Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000;
const video = (id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
	({ id, agentId: id, type: "video", name: id, mediaId: `m-${id}`, startTime: T(start), duration: T(duration), trimStart: T(0), trimEnd: T(10 - duration), sourceDuration: T(10), params: {}, ...extra }) as unknown as TimelineElement;
const scenesWith = (main: TimelineElement[], overlay: unknown[] = []): TScene[] => [{
	id: "main", name: "main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
	tracks: { main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: main }, overlay, audio: [] } as unknown as SceneTracks,
} as TScene];
const run = (scenes: TScene[], ops: unknown[]) =>
	computeAgentDraft({ scenes, rootSceneId: "main", ops: ops as never, mediaFor: () => undefined, canvas: { width: 1080, height: 1920 }, fps: { numerator: 30, denominator: 1 }, ripple: false });
const keys = (element: TimelineElement, path: string) =>
	((element.animations?.[path] as { keys?: { time: number; value: unknown }[] } | undefined)?.keys ?? []).map((k) => [s(k.time), k.value]);
const pair = () => scenesWith([video("A", 0, 2), video("B", 2, 2)]);

describe("transitions", () => {
	test("flash: a white full-canvas shape that fades in and out across the cut, on a track just above the clip", () => {
		const out = run(pair(), [{ op: "transition", match: { agentId: "B" }, type: "flash", duration: 0.4 }]);
		expect(out.results[0]).toMatchObject({ ok: true, type: "flash", duration: 0.4 });
		const overlay = out.scenes[0].tracks.overlay;
		const track = overlay[overlay.length - 1]; // the overlay right above the main track
		expect(track.name).toBe("Transition flashes");
		const flash = track.elements[0];
		expect([s(flash.startTime), s(flash.duration)]).toEqual([1.8, 0.4]);
		expect(flash.params.fill).toBe("#ffffff");
		expect(flash.agentId).toBe("B~flash");
		expect(keys(flash, "opacity")).toEqual([[0, 0], [0.2, 1], [0.4, 0]]);
	});

	test("dip is black by default; colours are checked", () => {
		const out = run(pair(), [{ op: "transition", match: { agentId: "B" }, type: "dip" }]);
		expect(out.scenes[0].tracks.overlay.at(-1)!.elements[0].params.fill).toBe("#000000");
		expect(run(pair(), [{ op: "transition", match: { agentId: "B" }, type: "flash", color: "red" }]).results[0]).toMatchObject({ ok: false });
	});

	test("crossfade: the end of the clip before continues above the next one and fades out", () => {
		const out = run(pair(), [{ op: "transition", match: { agentId: "B" }, type: "crossfade", duration: 0.5 }]);
		expect(out.results[0]).toMatchObject({ ok: true, type: "crossfade", duration: 0.5 });
		const track = out.scenes[0].tracks.overlay.at(-1)!;
		expect([track.name, track.type]).toEqual(["Transitions", "video"]);
		const tail = track.elements[0] as TimelineElement & { isSourceAudioEnabled?: boolean };
		expect([s(tail.startTime), s(tail.duration), s(tail.trimStart)]).toEqual([2, 0.5, 2]);
		expect(tail.isSourceAudioEnabled).toBe(false);
		expect(keys(tail, "opacity")).toEqual([[0, 1], [0.5, 0]]);
		// The clips themselves are unchanged.
		expect(out.scenes[0].tracks.main.elements.map((e) => [e.id, s(e.startTime), s(e.duration)])).toEqual([["A", 0, 2], ["B", 2, 2]]);
	});

	test("crossfade needs footage after the clip before: shortened to what there is, or refused", () => {
		const short = scenesWith([video("A", 0, 2, { trimEnd: T(0.2), sourceDuration: T(2.2) }), video("B", 2, 2)]);
		expect(run(short, [{ op: "transition", match: { agentId: "B" }, type: "crossfade", duration: 1 }]).results[0]).toMatchObject({ ok: true, duration: 0.2 });
		const none = scenesWith([video("A", 0, 2, { trimEnd: T(0), sourceDuration: T(2) }), video("B", 2, 2)]);
		expect(run(none, [{ op: "transition", match: { agentId: "B" }, type: "crossfade" }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("no footage") });
	});

	test("slide-left: the clip before slides out left while the clip slides in from the right", () => {
		const out = run(pair(), [{ op: "transition", match: { agentId: "B" }, type: "slide-left", duration: 0.3 }]);
		expect(out.results[0]).toMatchObject({ ok: true });
		const tail = out.scenes[0].tracks.overlay.at(-1)!.elements[0];
		expect(keys(tail, "transform.positionX")).toEqual([[0, 0], [0.3, -1080]]);
		const incoming = out.scenes[0].tracks.main.elements.find((e) => e.id === "B")!;
		expect(keys(incoming, "transform.positionX")).toEqual([[0, 1080], [0.3, 0]]);
	});

	test("no clip before, a bad type or duration, or a clip that already animates its position: refused", () => {
		const alone = scenesWith([video("B", 2, 2)]);
		expect(run(alone, [{ op: "transition", match: { agentId: "B" }, type: "crossfade" }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("no clip ends") });
		expect(run(pair(), [{ op: "transition", match: { agentId: "B" }, type: "wipe" }]).results[0]).toMatchObject({ ok: false });
		expect(run(pair(), [{ op: "transition", match: { agentId: "B" }, type: "flash", duration: 9 }]).results[0]).toMatchObject({ ok: false });
		const moving = scenesWith([video("A", 0, 2), video("B", 2, 2, { animations: { "transform.positionX": { keys: [{ id: "k", time: 0, value: 5 }] } } })]);
		expect(run(moving, [{ op: "transition", match: { agentId: "B" }, type: "slide-left" }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("already animates") });
	});

	test("a second transition reuses the Transitions track when it is free there", () => {
		const three = scenesWith([video("A", 0, 2), video("B", 2, 2), video("C", 4, 2)]);
		const out = run(three, [
			{ op: "transition", match: { agentId: "B" }, type: "crossfade", duration: 0.3 },
			{ op: "transition", match: { agentId: "C" }, type: "crossfade", duration: 0.3 },
		]);
		expect(out.results.map((r) => r.ok)).toEqual([true, true]);
		expect(out.scenes[0].tracks.overlay.length).toBe(1);
		expect(out.scenes[0].tracks.overlay[0].elements.length).toBe(2);
	});
});
