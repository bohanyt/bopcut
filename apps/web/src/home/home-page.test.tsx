import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Inbox } from "@/agent/inbox-types";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
// Release notes come from generated content; the home page only shows them.
mock.module("@/changelog/components/changelog-notification", () => ({ ChangelogNotification: () => null }));
mock.module("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }), redirect: () => {} }));
// Loaded before the globals below: some modules choose their code by the presence of a document.
const { EditorCore } = await import("@/core");
const { LocaleProvider } = await import("@/i18n/provider");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { HomePage } = await import("./home-page");

const dom = new Window({ url: "http://127.0.0.1:3000/" });
const globals = {
	window: dom,
	document: dom.document,
	navigator: dom.navigator,
	location: dom.location,
	history: dom.history,
	Node: dom.Node,
	HTMLElement: dom.HTMLElement,
	HTMLInputElement: dom.HTMLInputElement,
	KeyboardEvent: dom.KeyboardEvent,
	requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
	cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
	getComputedStyle: dom.getComputedStyle.bind(dom),
	IS_REACT_ACT_ENVIRONMENT: true,
};
const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
const originalFetch = globalThis.fetch;
let root: Root | null = null;
let inbox: Inbox = { bundle: null, draft: null };

beforeAll(() => {
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	globalThis.fetch = (async (url: string) => {
		if (String(url) === "/api/agent/inbox") return Response.json(inbox);
		throw new Error(`Unexpected fetch ${url}`);
	}) as typeof fetch;
});
afterAll(async () => {
	globalThis.fetch = originalFetch;
	await dom.close();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as Record<string, unknown>)[key];
	}
});
afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = null;
	dom.document.body.innerHTML = "";
	EditorCore.reset();
});

const project = { id: "p1", name: "Podcast 12", createdAt: new Date(0), updatedAt: new Date(0) };
const bundle = { rev: "r".repeat(64), modifiedAt: "2026-11-27T01:00:00.000Z", name: "Interview cut", assets: 2, items: 5, width: 1080, height: 1920 };
const draft = { rev: "d1", modifiedAt: "2026-11-27T02:00:00.000Z", projectId: "p1", label: "Tighten the intro", ops: 3 };

/** The inbox answer, and the tab panels' animation frames. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

async function show(url: string) {
	dom.happyDOM.setURL(url);
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	spyOn(editor.project, "loadAllProjects").mockResolvedValue();
	spyOn(editor.project, "getIsInitialized").mockReturnValue(true);
	spyOn(editor.project, "getIsLoading").mockReturnValue(false);
	spyOn(editor.project, "getProjectListError").mockReturnValue(null);
	spyOn(editor.project, "getSavedProjects").mockReturnValue([project] as never);
	spyOn(editor.project, "getFilteredAndSortedProjects").mockReturnValue([]);
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => {
		root?.render(<LocaleProvider initialLocale="en"><TooltipProvider><HomePage /></TooltipProvider></LocaleProvider>);
	});
	await settle();
}
const tab = (name: RegExp) => [...dom.document.querySelectorAll("[role='tab']")].find((node) => name.test(node.textContent ?? "")) as unknown as HTMLElement;
const panel = (trigger: HTMLElement) => dom.document.getElementById(trigger.getAttribute("aria-controls") ?? "") as unknown as HTMLElement;
const text = () => dom.document.body.textContent ?? "";
// A button can carry a short and a long label, one per screen size.
const button = (label: string) => [...dom.document.querySelectorAll("button")].find((node) => node.textContent?.includes(label)) ?? null;
const link = (label: string) => [...dom.document.querySelectorAll("a")].find((node) => node.textContent === label) ?? null;

test("a link to the agent's tab shows the bundle to import and the draft, with a link to its project", async () => {
	inbox = { bundle, draft };
	await show("http://127.0.0.1:3000/?tab=agent");
	const agent = tab(/From the agent/);
	expect(agent.getAttribute("aria-selected")).toBe("true");
	expect(agent.getAttribute("aria-label")).toBe("From the agent, 2 waiting");
	expect(text()).toContain("Interview cut");
	expect(text()).toContain("Files: 2 · Clips: 5 · 1080×1920");
	expect(button("Import as a project")).not.toBeNull();
	expect(text()).toContain("Tighten the intro");
	expect(text()).toContain("For Podcast 12");
	expect(text()).toContain("Changes: 3");
	expect(link("Open project")?.getAttribute("href")).toBe("/editor/p1");
	// The projects' controls belong to the Projects tab.
	expect(button("New project")).toBeNull();
});

test("the arrow keys switch tabs without losing focus, and the address follows", async () => {
	inbox = { bundle: null, draft: null };
	await show("http://127.0.0.1:3000/?tab=agent");
	const agent = tab(/From the agent/);
	await act(async () => { agent.focus(); });
	// The tabs move focus on the next task.
	await act(async () => { agent.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as never); });
	await settle();
	const projects = tab(/^Projects$/);
	expect(projects.getAttribute("aria-selected")).toBe("true");
	expect(dom.document.activeElement as unknown).toBe(projects);
	expect(dom.location.search).toBe("");
	// Both panels stay mounted; the other one is hidden.
	expect([panel(projects).hidden, panel(tab(/From the agent/)).hidden]).toEqual([false, true]);
	expect(button("New project")).not.toBeNull();
	await act(async () => { projects.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as never); });
	await settle();
	expect(tab(/From the agent/).getAttribute("aria-selected")).toBe("true");
	expect(dom.document.activeElement as unknown).toBe(tab(/From the agent/));
	expect(dom.location.search).toBe("?tab=agent");
});

test("a draft for a missing project or for no project has no link, and an empty inbox says so", async () => {
	inbox = { bundle: null, draft: { ...draft, projectId: "gone" } };
	await show("http://127.0.0.1:3000/?tab=agent");
	expect(text()).toContain("For a project that is not on this computer (gone).");
	expect(link("Open project")).toBeNull();
	expect(tab(/From the agent/).getAttribute("aria-label")).toBe("From the agent, 1 waiting");

	// The inbox is read again when the page is shown again.
	const refresh = async (next: Inbox) => {
		inbox = next;
		await act(async () => { dom.document.dispatchEvent(new dom.Event("visibilitychange")); });
		await act(async () => {});
	};
	await refresh({ bundle: null, draft: { ...draft, projectId: null } });
	expect(text()).toContain("Not tied to a project: it applies to the next project you open.");
	expect(link("Open project")).toBeNull();

	await refresh({ bundle: null, draft: null });
	expect(text()).toContain("Nothing new from the agent");
	expect(tab(/From the agent/).getAttribute("aria-label")).toBeNull();
});
