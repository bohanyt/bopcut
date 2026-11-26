import { afterEach, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import type { VideoElement } from "@/timeline";
import { speedOnFrameGrid } from "@/timeline/update-pipeline";
import { fixture, getHost, t, video } from "./compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");

const FRAME = 4000; // 30 fps
const fps = { numerator: 30, denominator: 1 };

afterEach(() => EditorCore.reset());

function setup(clips: VideoElement[]) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	getHost(scenes).tracks.main.elements = clips;
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	const clip = (id: string) => editor.scenes.getActiveScene().tracks.main.elements.find((element) => element.id === id) as VideoElement;
	return { editor, clip };
}

const sourceShown = (clip: VideoElement) => clip.trimStart + clip.duration * (clip.retime?.rate ?? 1) + clip.trimEnd;

test("a speed change keeps the clip and the clips rippled after it on the frame grid, at the rate asked", () => {
	const { editor, clip } = setup([video("first", 0, 1), video("second", 1, 1)]);
	editor.command.isRippleEnabled = true;
	const source = sourceShown(clip("first"));

	editor.timeline.updateElementRetime({ trackId: "t-main", elementId: "first", retime: { rate: 1.3 } });
	const first = clip("first");
	expect(first.retime?.rate).toBe(1.3);
	expect(first.duration % FRAME).toBe(0);
	expect(first.duration as number).toBe(23 * FRAME);
	// The part of a frame of footage that no longer fits goes into the end trim.
	expect(sourceShown(first)).toBeCloseTo(source, 0);
	expect(first.trimEnd).toBeGreaterThanOrEqual(0);
	expect(clip("second").startTime % FRAME).toBe(0);
	expect(clip("second").startTime).toBe(first.duration);

	editor.command.undo();
	expect(clip("first")).toMatchObject({ duration: t(1), trimEnd: t(0) });
	expect(clip("first").retime).toBeUndefined();
	expect(clip("second").startTime).toBe(t(1));
});

test("a sped-up clip stays at least one frame long", () => {
	const short = { ...video("short", 0, 1), duration: t(FRAME / 120000), trimEnd: t(1) } as VideoElement;
	const { editor, clip } = setup([short]);
	editor.timeline.updateElementRetime({ trackId: "t-main", elementId: "short", retime: { rate: 5 } });
	// One frame at 5x shows five frames of footage, taken from the trimmed tail.
	expect(clip("short")).toMatchObject({ duration: FRAME, retime: { rate: 5 } });
	expect(sourceShown(clip("short"))).toBeCloseTo(sourceShown(short), 0);
});

test("when one frame needs more footage than the clip has, the rate goes down until one frame fits", () => {
	expect(speedOnFrameGrid({ fps, duration: 800, rate: 5, availableSource: FRAME })).toEqual({ duration: FRAME, rate: 1, trimEnd: 0 });
	// Rounding up would need footage past the end: the duration rounds down instead.
	const down = speedOnFrameGrid({ fps, duration: 23.6 * FRAME, rate: 1.27, availableSource: 30 * FRAME });
	expect(down.duration).toBe(23 * FRAME);
	expect(down.duration * 1.27 + down.trimEnd).toBeCloseTo(30 * FRAME, 0);
});
