import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TextElement } from "@/timeline";
import { applyElementUpdate } from "@/timeline/update-pipeline";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import { distributeWordTimings } from "@/text/caption";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { buildBundleScenes } = await import("@/agent/importer");
const { EditorCore } = await import("@/core");

// The second test sets up the shared editor; leave it fresh for the next test file.
afterEach(() => EditorCore.reset());

const canvas = { width: 1280, height: 720 };

describe("editing the text of a trimmed caption", () => {
	test("inserting a word keeps the timings inside the trimmed window", () => {
		const built = buildBundleScenes({
			bundle: {
				name: "t",
				...canvas,
				assets: [],
				audio: [],
				main: [],
				overlay: [
					{
						type: "text",
						name: "Captions",
						elements: [
							{
								agent_id: "cap",
								name: "Caption",
								start: 0,
								duration: 2,
								trimStart: 1,
								caption: { text: "hello world" },
							},
						],
					},
				],
			},
			media: new Map(),
			sceneId: "main",
		});
		const trackId = built.tracks.overlay[0].id;
		const element = built.tracks.overlay[0].elements[0] as TextElement;
		const trimStartSec = element.trimStart / TICKS_PER_SECOND;
		expect(element.caption?.words[0].start).toBeCloseTo(trimStartSec, 6);

		const next = applyElementUpdate({
			element,
			patch: { params: { content: "hello big world" } },
			context: { tracks: built.tracks, trackId, boundaryIdPrefix: "qa" },
		}) as TextElement;

		expect(next.caption?.words[0].start).toBeGreaterThanOrEqual(trimStartSec);
	});

	test("editor.timeline.updateElements follows the same path as the properties panel", () => {
		EditorCore.reset();
		const editor = EditorCore.getInstance();
		editor.save.stop();
		const built = buildBundleScenes({
			bundle: {
				name: "t",
				...canvas,
				assets: [],
				audio: [],
				main: [],
				overlay: [
					{
						type: "text",
						name: "Captions",
						elements: [
							{
								agent_id: "cap",
								name: "Caption",
								start: 0,
								duration: 2,
								trimStart: 1,
								caption: { text: "hello world" },
							},
						],
					},
				],
			},
			media: new Map(),
			sceneId: "main",
		});
		editor.project.setActiveProject({
			project: {
				metadata: { id: "p", name: "p", duration: mediaTimeFromSeconds({ seconds: 0 }), createdAt: new Date(0), updatedAt: new Date(0) },
				scenes: [{ ...built, id: "main", name: "main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0) }],
				currentSceneId: "main",
				settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: canvas, background: { type: "color", color: "#000" } },
				version: 1,
			},
		});
		editor.scenes.setScenes({ scenes: editor.project.getActive().scenes, activeSceneId: "main" });
		const el = editor.scenes.getActiveScene().tracks.overlay[0].elements[0] as TextElement;
		const trackId = editor.scenes.getActiveScene().tracks.overlay[0].id;
		const trimStartSec = el.trimStart / TICKS_PER_SECOND;

		editor.timeline.updateElements({
			updates: [{ trackId, elementId: el.id, patch: { params: { content: "hi world" } } }],
		});
		const updated = editor.scenes.getActiveScene().tracks.overlay[0].elements[0] as TextElement;
		expect(updated.caption?.words.find((w) => w.text === "hi")?.start).toBeGreaterThanOrEqual(trimStartSec);
	});
});