import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { fixture } from "@/timeline/__tests__/compound-fixtures";

const prefetched: string[] = [];
mock.module("next/navigation", () => ({
	useRouter: () => ({ prefetch: (href: string) => { prefetched.push(href); }, push: () => {}, replace: () => {} }),
	usePathname: () => "/editor/p",
	useSearchParams: () => new URLSearchParams(),
}));
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
// Loaded before the globals below: some modules choose their code by the presence of a document.
const { EditorCore } = await import("@/core");
const { LocaleProvider } = await import("@/i18n/provider");
const { ProjectDropdown } = await import("./editor-header");

const dom = new Window({ url: "http://127.0.0.1:3000/editor/p" });
const globals = {
	window: dom,
	document: dom.document,
	navigator: dom.navigator,
	Node: dom.Node,
	HTMLElement: dom.HTMLElement,
	HTMLInputElement: dom.HTMLInputElement,
	IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
let root: Root;

beforeAll(() => {
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
});
afterAll(async () => {
	await dom.close();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as Record<string, unknown>)[key];
	}
});
afterEach(async () => {
	await act(async () => { root.unmount(); });
	EditorCore.reset();
});

test("opening the project menu fetches the project list ahead of Exit", async () => {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as never,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => { root.render(<LocaleProvider initialLocale="en"><ProjectDropdown /></LocaleProvider>); });
	expect(prefetched).toEqual([]);

	const trigger = dom.document.querySelector("button") as unknown as HTMLElement;
	await act(async () => {
		trigger.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }) as unknown as Event);
	});
	expect(trigger.getAttribute("aria-expanded")).toBe("true");
	expect(prefetched).toEqual(["/"]);
});
