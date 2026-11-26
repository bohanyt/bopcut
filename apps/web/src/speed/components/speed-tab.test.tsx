import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import { video } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { SpeedTab } = await import("@/speed/components/speed-tab");

let dom: Window;
let root: Root;
let restoreGlobals: () => void;

beforeEach(async () => {
	dom = new Window();
	const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
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
	EditorCore.reset();
});

test("scrubbing previews each snapped value once, however many pointer moves land on it", async () => {
	const previews: number[] = [];
	const commits: number[] = [];
	let draft: ReturnType<typeof usePropertyDraft<number>> | undefined;
	const Harness = () => {
		draft = usePropertyDraft({
			displayValue: "1",
			parse: (input) => Math.round(Number(input) * 100) / 100,
			onPreview: (value) => { previews.push(value); },
			onCommit: (value) => { commits.push(value); },
		});
		return null;
	};
	await act(async () => root.render(<Harness />));
	for (const value of [1.001, 1.002, 1.004, 1.011, 1.012, 1.004]) draft!.scrubTo(value);
	expect(previews).toEqual([1, 1.01, 1]);
	draft!.commitScrub();
	expect(commits).toEqual([1]);
	// A new scrub starts fresh: its first value is previewed even when it equals the last one.
	draft!.scrubTo(1);
	expect(previews).toEqual([1, 1.01, 1, 1]);
});

test("the speed field and the pitch switch are named", () => {
	const html = renderToStaticMarkup(<SpeedTab element={video("clip", 0, 2)} trackId="main" />);
	expect(html).toContain('aria-label="Speed"');
	const switchId = /<button[^>]*role="switch"[^>]*id="([^"]+)"|<button[^>]*id="([^"]+)"[^>]*role="switch"/.exec(html);
	const id = switchId?.[1] ?? switchId?.[2];
	expect(id).toBeTruthy();
	expect(html).toContain(`<label for="${id}" class="text-sm">Change pitch</label>`);
});
