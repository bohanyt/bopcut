import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { toast } from "sonner";
import { text } from "@/timeline/__tests__/compound-fixtures";
import type { TextElement } from "@/timeline";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { CaptionProperties } = await import("@/text/components/caption-properties");
const { createTextPreset } = await import("@/text/presets");

let dom: Window;
let root: Root;
let restoreGlobals: () => void;
const realFetch = globalThis.fetch;

beforeEach(async () => {
	dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		navigator: dom.navigator,
		HTMLElement: dom.HTMLElement,
		HTMLInputElement: dom.HTMLInputElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as unknown as HTMLElement);
});

afterEach(async () => {
	await act(async () => root.unmount());
	await dom.close();
	restoreGlobals();
	globalThis.fetch = realFetch;
	mock.restore();
	EditorCore.reset();
});

test("saving under a taken preset name says it replaces it, and Undo writes the old preset back", async () => {
	const base = text("title", 0, 4) as TextElement;
	const element = { ...base, params: { ...base.params, fontSize: 60 } };
	const old = createTextPreset("Judul", { ...element, params: { ...element.params, fontSize: 30 } });
	const saved: { name: string; fontSize: unknown }[] = [];
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		if (init?.method === "POST") {
			const preset = JSON.parse(String(init.body));
			saved.push({ name: preset.name, fontSize: preset.style.fontSize });
			return Response.json(preset);
		}
		return Response.json([old]);
	}) as unknown as typeof fetch;
	const success = spyOn(toast, "success");
	const editor = EditorCore.getInstance();
	spyOn(editor.playback, "getCurrentTime").mockReturnValue(0 as never);

	await act(async () => root.render(<CaptionProperties element={element} trackId="overlay" presetsOnly />));
	const input = dom.document.querySelector("input[aria-label='Preset name']") as unknown as HTMLInputElement;
	const saveButton = () =>
		[...dom.document.querySelectorAll("button")].find((button) => /^(Save|Replace)$/.test(button.textContent ?? "")) as unknown as HTMLElement | undefined;
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "Judul");
		input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
	});
	expect(saveButton()?.textContent).toBe("Replace");
	expect(dom.document.body.textContent).toContain("A preset named “Judul” exists.");

	await act(async () => saveButton()!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
	expect(saved).toEqual([{ name: "Judul", fontSize: 60 }]);
	const [message, options] = success.mock.calls.at(-1)! as [string, { action: { label: string; onClick: () => void } }];
	expect(message).toBe("Preset “Judul” replaced");

	await act(async () => options.action.onClick());
	expect(saved.at(-1)).toEqual({ name: "Judul", fontSize: 30 });
});
