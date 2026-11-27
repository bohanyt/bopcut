import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { Inbox } from "@/agent/inbox-types";
import type { AccountsStatus, CookieCheck } from "@/accounts/types";

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
let accounts: AccountsStatus = { cookies: { browser: null, source: "none" } };
let check: CookieCheck = { ok: false, error: "not set" };
const posts: { url: string; body: unknown }[] = [];

beforeAll(() => {
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	globalThis.fetch = (async (url: string, init?: RequestInit) => {
		if (String(url) === "/api/agent/inbox") return Response.json(inbox);
		if (init?.method === "POST") posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
		if (String(url) === "/api/agent/accounts") {
			const chosen = posts.at(-1)?.body as { cookiesFromBrowser?: string | null } | undefined;
			if (init?.method === "POST") accounts = { cookies: { browser: chosen?.cookiesFromBrowser ?? null, source: "accounts" } };
			return Response.json(accounts);
		}
		if (String(url) === "/api/agent/accounts/test") return Response.json(check);
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

async function show(url: string, setup?: (editor: ReturnType<typeof EditorCore.getInstance>) => void) {
	dom.happyDOM.setURL(url);
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	spyOn(editor.project, "loadAllProjects").mockResolvedValue();
	spyOn(editor.project, "getIsInitialized").mockReturnValue(true);
	spyOn(editor.project, "getIsLoading").mockReturnValue(false);
	spyOn(editor.project, "getProjectListError").mockReturnValue(null);
	spyOn(editor.project, "getSavedProjects").mockReturnValue([project] as never);
	spyOn(editor.project, "getFilteredAndSortedProjects").mockReturnValue([]);
	setup?.(editor);
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

test("the Accounts tab chooses the cookie browser and tests it", async () => {
	accounts = { cookies: { browser: "chrome", source: "env" } };
	posts.length = 0;
	await show("http://127.0.0.1:3000/?tab=accounts");
	await settle();
	const select = dom.document.querySelector("select[aria-label='Browser for cookies']") as unknown as HTMLSelectElement;
	expect(select.selectedOptions[0]?.textContent).toBe("Chrome (from .env.local)");
	expect(text()).toContain("Firefox works best.");

	check = { ok: true, browser: "chrome", cookies: 12, undecrypted: 3 };
	await act(async () => { button("Test")!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as never); });
	await settle();
	expect(text()).toContain("Read 12 cookies from Chrome. 3 more could not be decrypted, so some sites may still ask for a login.");

	// Choosing saves at once; the old result goes.
	await act(async () => {
		select.value = "firefox";
		select.dispatchEvent(new dom.Event("change", { bubbles: true }) as never);
	});
	await settle();
	expect(posts).toEqual([
		{ url: "/api/agent/accounts/test", body: {} },
		{ url: "/api/agent/accounts", body: { cookiesFromBrowser: "firefox" } },
	]);
	expect(select.value).toBe("firefox");
	expect([...select.options].some((option) => option.textContent?.includes(".env.local"))).toBe(false);
	expect(text()).not.toContain("Read 12 cookies");

	check = { ok: false, error: "could not find firefox cookies database" };
	await act(async () => { button("Test")!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as never); });
	await settle();
	expect(text()).toContain("The cookies could not be read");
	expect(text()).toContain("could not find firefox cookies database");

	// None: nothing to test.
	await act(async () => {
		select.value = "";
		select.dispatchEvent(new dom.Event("change", { bubbles: true }) as never);
	});
	await settle();
	expect(posts.at(-1)).toEqual({ url: "/api/agent/accounts", body: { cookiesFromBrowser: null } });
	expect(button("Test")?.disabled).toBe(true);
});

test("archived projects have their own view, and a selection there restores them", async () => {
	inbox = { bundle: null, draft: null };
	// The same arrays each time, as the editor's list keeps them while nothing changes.
	const archivedList = [{ ...project, id: "old", name: "Old cut", duration: 0 }];
	const mainList = [{ ...project, duration: 0 }];
	let archive: ReturnType<typeof spyOn> | undefined;
	await show("http://127.0.0.1:3000/", (editor) => {
		spyOn(editor.project, "getArchivedCount").mockReturnValue(1);
		spyOn(editor.project, "isArchived").mockImplementation(({ id }: { id: string }) => id === "old");
		spyOn(editor.project, "getFilteredAndSortedProjects").mockImplementation(({ archived }: { archived?: boolean }) =>
			(archived ? archivedList : mainList) as never);
		archive = spyOn(editor.project, "setProjectsArchived").mockResolvedValue(true);
	});
	expect(text()).toContain("Podcast 12");
	expect(text()).not.toContain("Old cut");

	await act(async () => { button("Archived (1)")!.click(); });
	expect(text()).toContain("Old cut");
	expect(text()).not.toContain("Podcast 12");
	const select = dom.document.querySelector("[aria-label='Select Old cut']") as unknown as HTMLElement;
	await act(async () => { select.click(); });
	await act(async () => { (dom.document.querySelector("button[aria-label='Restore']") as unknown as HTMLElement).click(); });
	expect(archive).toHaveBeenCalledWith({ ids: ["old"], archived: false });

	await act(async () => { button("All projects")!.click(); });
	expect(text()).toContain("Podcast 12");
});

test("projects show their mode, and the list can show one mode", async () => {
	inbox = { bundle: null, draft: null };
	const clip = { ...project, id: "clip", name: "Stream clip", duration: 0, mode: "editing" as const };
	const story = { ...project, id: "story", name: "Explainer", duration: 0, mode: "creating" as const };
	// The same arrays each time, as the editor's list keeps them while nothing changes.
	const lists = { all: [clip, story], editing: [clip], creating: [story], generating: [] };
	await show("http://127.0.0.1:3000/", (editor) => {
		spyOn(editor.project, "getSavedProjects").mockReturnValue([clip, story] as never);
		spyOn(editor.project, "getFilteredAndSortedProjects").mockImplementation(({ mode = "all" }: { mode?: "all" | "editing" | "creating" | "generating" }) =>
			lists[mode] as never);
	});
	const filter = dom.document.querySelector("[role='group'][aria-label='Show projects by mode']")!;
	expect([...filter.querySelectorAll("button")].map((node) => node.textContent)).toEqual(["All", "Editing", "Creating"]);
	expect(text()).toContain("Stream clip");
	expect(text()).toContain("Explainer");
	await act(async () => { ([...filter.querySelectorAll("button")].find((node) => node.textContent === "Creating") as unknown as HTMLElement).click(); });
	expect(text()).toContain("Explainer");
	expect(text()).not.toContain("Stream clip");
	await act(async () => { ([...filter.querySelectorAll("button")].find((node) => node.textContent === "All") as unknown as HTMLElement).click(); });
	expect(text()).toContain("Stream clip");
});
