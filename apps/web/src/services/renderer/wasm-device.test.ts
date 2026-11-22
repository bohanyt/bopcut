import { expect, test } from "bun:test";
import * as wasm from "opencut-wasm";

test("the bundled WASM can drop the device and compositor before initialization", () => {
	expect(wasm.getGpuWebGlCanvas()).toBeUndefined();
	expect(() => wasm.resetGpu()).not.toThrow();
	expect(() => wasm.getCompositorCanvas()).toThrow("Compositor is not initialized");
});

test("the bundled WASM reports unavailable backends without trapping", async () => {
	await expect(wasm.initializeGpu()).rejects.toContain("WebGL2 initialization failed");
	expect(wasm.getGpuWebGlCanvas()).toBeUndefined();
	wasm.resetGpu();
});
