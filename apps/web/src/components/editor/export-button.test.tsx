import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { fixture } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
// Loaded before the globals below: some modules choose their code by the presence of a document.
const { EditorCore } = await import("@/core");
const { LocaleProvider } = await import("@/i18n/provider");
const { ExportButton } = await import("./export-button");

const dom = new Window();
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
let cancelled = 0;
let cleared = 0;

function setup({ isExporting }: { isExporting: boolean }) {
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
	const state = { isExporting, progress: isExporting ? 0.42 : 0, result: null };
	editor.project.getExportState = () => state;
	editor.project.cancelExport = () => { cancelled++; };
	editor.project.clearExportState = () => { cleared++; };
}

async function render() {
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => { root.render(<LocaleProvider initialLocale="en"><ExportButton /></LocaleProvider>); });
}
const trigger = () => dom.document.querySelector("button")!;
// The panel's content does not render in happy-dom; the trigger tells whether it is open.
const panelOpen = () => trigger().getAttribute("aria-expanded") === "true";

/** Opens the panel, then closes it with the Export button again (like Escape or a click outside). */
async function openThenClose() {
	await act(async () => { trigger().click(); });
	expect(panelOpen()).toBe(true);
	await act(async () => { trigger().click(); });
	expect(panelOpen()).toBe(false);
}

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
beforeEach(() => {
	cancelled = 0;
	cleared = 0;
});
afterEach(async () => {
	await act(async () => { root.unmount(); });
	dom.document.body.innerHTML = "";
	EditorCore.reset();
});

describe("closing the Export panel", () => {
	test("during an export keeps it running, and the button shows how far it is", async () => {
		setup({ isExporting: true });
		await render();
		await openThenClose();
		expect([cancelled, cleared]).toEqual([0, 0]);
		expect(trigger().textContent).toContain("42%");
	});

	test("with no export running clears what the last one left", async () => {
		setup({ isExporting: false });
		await render();
		await openThenClose();
		expect([cancelled, cleared]).toEqual([0, 1]);
		expect(trigger().textContent).not.toContain("%");
	});
});
