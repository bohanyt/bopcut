import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TimelineElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { computeAgentDraft } = await import("./draft");
const { fieldsMapOf } = await import("./stale");
const { buildBundleScenes } = await import("./importer");
const { readAnimationPresets } = await import("@/animation/presets");
const { resolveAnimationPathValueAtTime } = await import("@/animation/resolve");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const video = (id: string, start: number, duration: number) =>
	({ id, agentId: id, type: "video", name: id, mediaId: `m-${id}`, startTime: T(start), duration: T(duration), trimStart: T(0), trimEnd: T(10 - duration), sourceDuration: T(10), params: {} }) as unknown as TimelineElement;
const scenesWith = (main: TimelineElement[], audio: unknown[] = []): TScene[] => [{
	id: "main", name: "main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
	tracks: { main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: main }, overlay: [], audio } as unknown as SceneTracks,
} as TScene];
const run = (scenes: TScene[], ops: unknown[], base?: ReturnType<typeof fieldsMapOf>) =>
	computeAgentDraft({ scenes, rootSceneId: "main", ops: ops as never, mediaFor: () => undefined, canvas: { width: 1080, height: 1920 }, fps: { numerator: 30, denominator: 1 }, ripple: false, base });
const opacity = (element: TimelineElement, seconds: number) =>
	resolveAnimationPathValueAtTime({ animations: element.animations, propertyPath: "opacity", localTime: T(seconds), fallbackValue: 1 }) as number;

describe("animate for agents", () => {
	test("the animate op writes presets on the matched clip and reports them", () => {
		const out = run(scenesWith([video("A", 0, 2)]), [{ op: "animate", match: { agentId: "A" }, in: "pop", out: { type: "fade", duration: 0.5 } }]);
		expect(out.results[0]).toMatchObject({ ok: true, animate: { in: { type: "pop", duration: 0.35 }, out: { type: "fade", duration: 0.5 } } });
		const clip = out.scenes[0].tracks.main.elements[0];
		expect(opacity(clip, 0)).toBe(0);
		expect(opacity(clip, 1)).toBeCloseTo(1, 6);
		expect(opacity(clip, 2)).toBe(0);
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
		expect(run(scenes, [{ op: "animate", match: { agentId: "S" }, in: "fade" }]).results[0]).toMatchObject({ ok: false, error: expect.stringContaining("visual clips") });
	});

	test("animate on an added element starts and ends at the values its keyframes give", () => {
		const out = run(scenesWith([]), [{
			op: "add", track: { name: "Titles", type: "text" },
			element: { agent_id: "T", name: "Title", text: "Hi", start: 0, duration: 2, keyframes: [{ path: "opacity", time: 1, value: 0.5 }], animate: { in: { type: "fade", duration: 0.5 }, out: "typewriter" } },
		}]);
		expect(out.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("animate.out must be one of") });
		const ok = run(scenesWith([]), [{
			op: "add", track: { name: "Titles", type: "text" },
			element: { agent_id: "T", name: "Title", text: "Hi", start: 0, duration: 2, keyframes: [{ path: "opacity", time: 1, value: 0.5 }], animate: { in: { type: "typewriter", duration: 1 }, out: "fade" } },
		}]);
		expect(ok.results[0]).toMatchObject({ ok: true });
		const title = ok.scenes[0].tracks.overlay.flatMap((t): TimelineElement[] => t.elements).find((e) => e.agentId === "T")!;
		expect(readAnimationPresets(title)).toEqual({ in: { type: "typewriter", duration: 1 }, out: { type: "fade", duration: 0.3 } });
		expect(opacity(title, 1.7)).toBeCloseTo(0.5, 6); // the keyframe's value where the fade out starts
		expect(opacity(title, 2)).toBe(0);
	});

	test("bundles take animate too", () => {
		const { tracks } = buildBundleScenes({
			bundle: { name: "b", width: 1080, height: 1920, overlay: [{ name: "Titles", type: "text", elements: [{ agent_id: "T", name: "Title", text: "Hi", start: 0, duration: 2, animate: { in: "impact" } }] }] } as never,
			media: new Map(), sceneId: "main",
		});
		const title = tracks.overlay[0].elements[0];
		expect(readAnimationPresets(title).in?.type).toBe("impact");
	});

	test("a draft based on an old snapshot does not redo blur after the user changed its effect", () => {
		const blurred = run(scenesWith([video("A", 0, 2)]), [{ op: "animate", match: { agentId: "A" }, in: "blur" }]).scenes;
		const base = fieldsMapOf(blurred);
		// The user turns the preset's blur off afterwards.
		const clip = blurred[0].tracks.main.elements[0] as TimelineElement & { effects: { id: string; enabled: boolean }[] };
		const off = scenesWith([{ ...clip, effects: clip.effects.map((e) => ({ ...e, enabled: false })) } as TimelineElement]);
		expect(run(off, [{ op: "animate", match: { agentId: "A" }, in: { type: "blur", duration: 1 } }], base).results[0]).toMatchObject({ ok: false, stale: true });
		// A fade only changes keyframes: not stale for that.
		const fade = run(scenesWith([video("A", 0, 2)]), [{ op: "animate", match: { agentId: "A" }, in: "fade" }], fieldsMapOf(scenesWith([video("A", 0, 2)])));
		expect(fade.results[0]).toMatchObject({ ok: true });
	});

	test("an out preset stays at the end when the agent changes the clip's length", () => {
		const animated = run(scenesWith([video("A", 0, 2)]), [{ op: "animate", match: { agentId: "A" }, out: "fade" }]).scenes;
		const longer = run(animated, [{ op: "set", match: { agentId: "A" }, duration: 3 }]);
		const clip = longer.scenes[0].tracks.main.elements[0];
		expect(opacity(clip, 2)).toBeCloseTo(1, 6);
		expect(opacity(clip, 3)).toBe(0);
	});

	test("dragging a trim shows the out preset where releasing it puts it", async () => {
		const { EditorCore } = await import("@/core");
		EditorCore.reset();
		const editor = EditorCore.getInstance();
		editor.save.stop();
		const animated = run(scenesWith([video("A", 0, 2)]), [{ op: "animate", match: { agentId: "A" }, out: "fade" }]).scenes;
		editor.project.setActiveProject({ project: { metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) }, scenes: animated, currentSceneId: "main", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 } } } as never });
		editor.scenes.setScenes({ scenes: animated, activeSceneId: "main" });
		const clip = animated[0].tracks.main.elements[0];
		editor.timeline.previewElements({ updates: [{ trackId: "t-main", elementId: clip.id, updates: { duration: T(3) } }] });
		const previewed = editor.timeline.getPreviewTracks()!.main.elements[0];
		expect(opacity(previewed, 2)).toBeCloseTo(1, 6);
		expect(opacity(previewed, 3)).toBe(0);
		editor.timeline.discardPreview();
		EditorCore.reset();
	});
});

