import { afterEach, expect, mock, test } from "bun:test";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";
import { getVisibleElementsWithBounds } from "@/preview/element-bounds";
import type { VideoElement } from "@/timeline";
import type { GrayFrame } from "../point-track";
import type { SourceRect } from "../split-layout";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { applySplitLayout } = await import("../apply-split-layout");
const { followFace } = await import("../apply-face-follow");
afterEach(() => EditorCore.reset());

const facecam = { x: 0.73, y: 0.62, width: 0.25, height: 0.34 };
/**
 * Where the nose is at a time (seconds), in fractions of the facecam part: within the middle the
 * zoomed-in window can reach (near the facecam's edge the window stops and the nose moves off centre).
 */
const nose = (time: number) => ({ x: 0.5 + 0.05 * Math.sin(time), y: 0.5 + 0.04 * Math.cos(time / 2) });

function random(seed: number) {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
}
const pattern = Array.from({ length: 13 * 13 }, (_, i) => {
	const x = (i % 13) - 6, y = Math.floor(i / 13) - 6, r = Math.hypot(x, y);
	return r < 2 ? 230 : r < 4 ? 40 : x > 2 && y < -2 ? 255 : 150 + 10 * Math.sin(x * y);
});
/** Frames of the facecam part as the editor would read them, with the nose drawn where `nose` says. */
const readFrames = async ({ crop, times }: { crop: SourceRect; times: number[] }): Promise<GrayFrame[]> => {
	expect(crop).toEqual(facecam);
	const width = 160, height = Math.round((160 * crop.height * 1080) / (crop.width * 1920));
	const next = random(5);
	const background = Uint8Array.from({ length: width * height }, () => 70 + next() * 70);
	return times.map((time) => {
		const data = background.slice();
		const at = nose(time);
		const cx = Math.round(at.x * width), cy = Math.round(at.y * height);
		for (let y = 0; y < 13; y++) for (let x = 0; x < 13; x++) data[(cy - 6 + y) * width + cx - 6 + x] = pattern[y * 13 + x];
		return { time, width, height, data };
	});
};

function setup() {
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks.main.elements = [video("stream", 0, 8)];
	host.tracks.overlay = [];
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
		scenes, currentSceneId: "main",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 }, background: { type: "color", color: "#000" } },
	} as never });
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.media.setAssets({ assets: [{ id: "media-stream", name: "Stream", type: "video", width: 1920, height: 1080, file: new File(["v"], "v.mp4") }] });
	const cam = applySplitLayout(editor, { clip: { trackId: host.tracks.main.id, elementId: "stream" }, facecam })!;
	return { editor, cam };
}
const camClip = (editor: ReturnType<typeof setup>["editor"], id: string) =>
	editor.timeline.getElementsWithTracks({ elements: [{ trackId: editor.scenes.getActiveScene().tracks.overlay[0].id, elementId: id }] })[0].element as VideoElement;

/** A point of the facecam part on the canvas, through the copy as the layout left it. */
function onCanvas(clip: VideoElement, point: { x: number; y: number }) {
	const shownW = 1080 * Number(clip.params["transform.scaleX"]), shownH = 607.5 * Number(clip.params["transform.scaleY"]);
	const left = 540 + Number(clip.params["transform.positionX"]) - shownW / 2;
	const top = 960 + Number(clip.params["transform.positionY"]) - shownH / 2;
	return { x: left + (facecam.x + point.x * facecam.width) * shownW, y: top + (facecam.y + point.y * facecam.height) * shownH };
}

test("a click on the nose makes the facecam follow it with editable keys, in one Undo step", async () => {
	const { editor, cam } = setup();
	const before = camClip(editor, cam.elementId);
	expect(before.reframe?.facecam).toEqual(facecam);
	const result = await followFace(editor, { clip: cam, point: onCanvas(before, nose(0)), readFrames });
	expect(result).toMatchObject({ ok: true, lostShare: 0, zoom: 1.15 });
	const after = camClip(editor, cam.elementId);
	expect(Number(after.params["transform.scaleX"])).toBeCloseTo(Number(before.params["transform.scaleX"]) * 1.15, 6);
	const keys = after.animations?.["transform.positionX"] as unknown as { keys?: unknown[] } | undefined;
	expect(result.ok && result.keys).toBeGreaterThan(2);
	expect(keys).toBeDefined();
	// Played back, the nose sits at the centre of the facecam window (540, 1536), within a few pixels.
	for (const seconds of [0.5, 2, 4.3, 7]) {
		const [entry] = getVisibleElementsWithBounds({
			tracks: editor.scenes.getActiveScene().tracks, currentTime: t(seconds), canvasSize: { width: 1080, height: 1920 },
			mediaAssets: editor.media.getAssets(), onlyElements: [cam],
		});
		const { cx, cy, width, height } = entry.bounds;
		const at = nose(seconds);
		const x = cx - Math.abs(width) / 2 + (facecam.x + at.x * facecam.width) * Math.abs(width);
		const y = cy - Math.abs(height) / 2 + (facecam.y + at.y * facecam.height) * Math.abs(height);
		expect(Math.abs(x - 540)).toBeLessThan(12);
		expect(Math.abs(y - 1536)).toBeLessThan(12);
	}
	// Undo puts the static layout back.
	editor.command.undo();
	expect(camClip(editor, cam.elementId).animations?.["transform.positionX"]).toBeUndefined();
	expect(camClip(editor, cam.elementId).params["transform.scaleX"]).toBe(before.params["transform.scaleX"]);
});

test("a click on a flat part of the picture says there is nothing to follow", async () => {
	const { editor, cam } = setup();
	const flat = async ({ times }: { times: number[] }) => times.map((time) => ({ time, width: 160, height: 96, data: new Uint8Array(160 * 96).fill(120) }));
	const clip = camClip(editor, cam.elementId);
	expect(await followFace(editor, { clip: cam, point: onCanvas(clip, { x: 0.5, y: 0.5 }), readFrames: flat })).toEqual({ ok: false, reason: "no-detail" });
	expect(camClip(editor, cam.elementId).animations).toBeUndefined();
});

test("a click outside the facecam, or on a clip without a window, starts nothing", async () => {
	const { editor, cam } = setup();
	expect(await followFace(editor, { clip: cam, point: { x: 540, y: 300 }, readFrames })).toEqual({ ok: false, reason: "outside" });
	const game = { trackId: editor.scenes.getActiveScene().tracks.main.id, elementId: "stream" };
	(editor.scenes.getActiveScene().tracks.main.elements[0] as VideoElement).masks![0].params.canvasLocked = false;
	expect(await followFace(editor, { clip: game, point: { x: 540, y: 500 }, readFrames })).toEqual({ ok: false, reason: "not-a-window" });
	expect(editor.command.canUndo()).toBe(true);
	editor.command.undo();
	expect(editor.command.canUndo()).toBe(false);
});
