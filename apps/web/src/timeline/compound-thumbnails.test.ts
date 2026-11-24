import { expect, mock, spyOn, test } from "bun:test";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { getCompoundThumbnailCache } = await import("@/timeline/compound-thumbnails");

const settle = () => new Promise((resolve) => setTimeout(resolve, 450));

test("queued thumbnail is not rendered while an export runs and is rendered after it ended; playback behaviour is unchanged", async () => {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const exporting = spyOn(editor.renderer, "isExportRunning").mockReturnValue(true);
	const playing = spyOn(editor.playback, "getIsPlaying").mockReturnValue(false);
	const cache = getCompoundThumbnailCache({ editor });
	const renders: string[] = [];
	cache.request("k", async () => {
		renders.push("k");
		return ["frame"];
	});
	await settle();
	expect(renders).toEqual([]);

	exporting.mockReturnValue(false);
	await settle();
	expect(renders).toEqual(["k"]);

	renders.length = 0;
	exporting.mockReturnValue(false);
	playing.mockReturnValue(true);
	cache.request("p", async () => {
		renders.push("p");
		return ["frame"];
	});
	await settle();
	expect(renders).toEqual([]);
	playing.mockReturnValue(false);
	await settle();
	expect(renders).toEqual(["p"]);

	exporting.mockRestore();
	playing.mockRestore();
	EditorCore.reset();
});