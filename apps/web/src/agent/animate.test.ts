import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TimelineElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { computeAgentDraft } = await import("./draft");
const { fieldsMapOf } = await import("./stale");
const { buildBundleScenes } = await import("./importer");
const { readAnimationPresets } = await import("@/animation/presets");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const video = (id: string, start: number, duration: number) =>
	({ id, agentId: id, type: "video", name: id, mediaId: `m-${id}`, startTime: T(start), duration: T(duration), trimStart: T(0), trimEnd: T(10 - duration), sourceDuration: T(10), params: {} }) as unknown as TimelineElement;
const scenesWith = (main: TimelineElement[], audio: unknown[] = []): TScene[] => [{
	id: "main", name: "main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
	tracks: { main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: main }, overlay: [], audio } as unknown as SceneTracks,
} as TScene];
const run = (scenes: TScene[], ops: unknown[], base?: ReturnType<typeof fieldsMapOf>) =>
	computeAgentDraft({ scenes, rootSceneId: "main", ops: ops as never, mediaFor: () => undefined, canvas: { width: 1080, height: 1920 }, fps: { numerator: 30, denominator: 1 }, ripple: false, base });

describe("animate for agents", () => {
	test("the animate op sets presets on the matched clip and reports them", () => {
		const out = run(scenesWith([video("A", 0, 2)]), [{ op: "animate", match: { agentId: "A" }, in: "pop", out: { type: "fade", duration: 0.5 } }]);
		expect(out.results[0]).toMatchObject({ ok: true, animate: { in: { type: "pop", duration: 0.35 }, out: { type: "fade", duration: 0.5 } } });
		// Again with none: that side's preset goes, the other stays.
		const again = run(out.scenes, [{ op: "animate", match: { agentId: "A" }, in: "none" }]);
		expect(readAnimationPresets(again.scenes[0].tracks.main.elements[0])).toEqual({ in: null, out: { type: "fade", duration: 0.5 } });
	});

	test("bad requests and clips without a picture are refused", () => {
		const audio = [{ id: "t-a", name: "Audio", type: "audio", muted: false, elements: [{ ...video("S", 0, 2), type: "audio" }] }];
		const scenes = scenesWith([video("A", 0, 2)], audio);
		expect(run(scenes, [{ op: "animate", match: { agentId: "A" }, in: "spin" }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("animate.in must be one of") });
		expect(run(scenes, [{ op: "animate", match: { agentId: "A" } }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("needs in or out") });
		expect(run(scenes, [{ op: "animate", match: { agentId: "A" }, in: "typewriter" }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("typewriter is for text") });
		expect(run(scenes, [{ op: "animate", match: { agentId: "A" }, in: { type: "fade", duration: 0.000001 } }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("0.05 to 10 seconds") });
		expect(run(scenes, [{ op: "animate", match: { agentId: "S" }, in: "fade" }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("visual clips") });
	});

	test("animate on an added element and in bundles", () => {
		const bad = run(scenesWith([]), [{ op: "add", track: { name: "Titles", type: "text" }, element: { agent_id: "T", name: "Title", text: "Hi", start: 0, duration: 2, animate: { out: "typewriter" } } }]);
		expect(bad.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("animate.out must be one of") });
		const ok = run(scenesWith([]), [{ op: "add", track: { name: "Titles", type: "text" }, element: { agent_id: "T", name: "Title", text: "Hi", start: 0, duration: 2, keyframes: [{ path: "opacity", time: 1, value: 0.5 }], animate: { in: { type: "typewriter", duration: 1 }, out: "fade" } } }]);
		expect(ok.results[0]).toMatchObject({ ok: true });
		const title = ok.scenes[0].tracks.overlay.flatMap((t): TimelineElement[] => t.elements).find((e) => e.agentId === "T")!;
		expect(readAnimationPresets(title)).toEqual({ in: { type: "typewriter", duration: 1 }, out: { type: "fade", duration: 0.3 } });
		expect(title.animations?.opacity).toBeDefined(); // its own keyframes are kept as they are
		const { tracks } = buildBundleScenes({
			bundle: { name: "b", width: 1080, height: 1920, overlay: [{ name: "Titles", type: "text", elements: [{ agent_id: "T", name: "Title", text: "Hi", start: 0, duration: 2, animate: { in: "impact" } }] }] } as never,
			media: new Map(), sceneId: "main",
		});
		expect(readAnimationPresets(tracks.overlay[0].elements[0]).in?.type).toBe("impact");
	});

	test("a draft based on an old snapshot does not redo a side the user changed since", () => {
		const animated = run(scenesWith([video("A", 0, 2)]), [{ op: "animate", match: { agentId: "A" }, in: "pop", out: "fade" }]).scenes;
		const base = fieldsMapOf(animated);
		// The user changes the in preset afterwards.
		const clip = animated[0].tracks.main.elements[0];
		const changed = scenesWith([{ ...clip, params: { ...clip.params, "animation.in": "impact" } } as TimelineElement]);
		expect(run(changed, [{ op: "animate", match: { agentId: "A" }, in: "blur" }], base).results[0]).toMatchObject({ ok: false, stale: true });
		// The out side the user left alone can still be changed.
		expect(run(changed, [{ op: "animate", match: { agentId: "A" }, out: "fall" }], base).results[0]).toMatchObject({ ok: true });
	});
});
