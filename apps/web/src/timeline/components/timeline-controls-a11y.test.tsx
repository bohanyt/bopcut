import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VolumeHighIcon, VolumeOffIcon } from "@hugeicons/core-free-icons";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { TrackToggleIcon } = await import("./index");
const { PresetItem } = await import("./graph-editor/popover");
const { removePreset, restorePreset, savePreset, useCustomPresets } = await import("./graph-editor/custom-presets-store");

const store = new Map<string, string>();
const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeAll(() => {
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
		removeItem: (key: string) => void store.delete(key),
	} });
});
afterAll(() => {
	if (previous) Object.defineProperty(globalThis, "localStorage", previous);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

test("track mute and hide toggles are named buttons", () => {
	const html = renderToStaticMarkup(
		<TrackToggleIcon isOff label="Unmute track" icons={{ on: VolumeHighIcon, off: VolumeOffIcon }} onClick={() => {}} />,
	);
	expect(html).toStartWith('<button type="button" aria-label="Unmute track" title="Unmute track"');
	expect(html).toContain("before:-inset-1");
});

test("a saved preset's delete button is named, sits next to the preset button and shows on touch screens", () => {
	const html = renderToStaticMarkup(
		<PresetItem value={[0.25, 0.1, 0.25, 1]} label="Custom 1" isActive={false} onSelect={() => {}}
			onDelete={() => {}} deleteLabel="Delete preset Custom 1" />,
	);
	// The preset button closes before the delete button starts: no button inside a button.
	const presetEnd = html.indexOf("</button>");
	const deleteStart = html.indexOf('aria-label="Delete preset Custom 1"');
	expect(presetEnd).toBeGreaterThan(0);
	expect(deleteStart).toBeGreaterThan(presetEnd);
	expect(html).toContain("pointer-coarse:flex");
	expect(html).toContain("group-focus-within:flex");
});

test("a deleted preset can be put back at its place", () => {
	savePreset({ value: [0.1, 0.2, 0.3, 0.4] });
	savePreset({ value: [0.5, 0.6, 0.7, 0.8] });
	const read = () => JSON.parse(store.get([...store.keys()][0]) ?? "{}");
	const before = read();
	const ids = (before.presets ?? before).map(({ id }: { id: string }) => id);
	const removed = removePreset({ id: ids[0] });
	expect(removed).toMatchObject({ index: 0, preset: { id: ids[0] } });
	expect(removePreset({ id: "missing" })).toBeNull();
	restorePreset(removed!);
	expect(read()).toEqual(before);
	expect(typeof useCustomPresets).toBe("function");
});
