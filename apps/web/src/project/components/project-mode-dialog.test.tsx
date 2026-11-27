import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";

// The Radix dialog does not render in happy-dom: a plain stand-in shows its content while open.
const realDialog = { ...(await import("@/components/ui/dialog")) };
const plain = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@/components/ui/dialog", () => ({
	...realDialog,
	Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? <div>{children}</div> : null),
	DialogBody: plain, DialogContent: plain, DialogHeader: plain, DialogTitle: plain, DialogDescription: plain,
}));
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const pushed: string[] = [];
mock.module("next/navigation", () => ({ useRouter: () => ({ push: (url: string) => pushed.push(url), replace: () => {}, prefetch: () => {} }), redirect: () => {} }));
const { EditorCore } = await import("@/core");
const { LocaleProvider } = await import("@/i18n/provider");
const { ProjectModeDialog } = await import("./project-mode-dialog");
const { NewProjectButton } = await import("@/home/projects-tab");

const dom = new Window({ url: "http://127.0.0.1:3000/" });
const globals = { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
beforeAll(() => {
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
});
afterAll(async () => {
	mock.module("@/components/ui/dialog", () => realDialog);
	EditorCore.reset();
	await dom.close();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else delete (globalThis as Record<string, unknown>)[key];
	}
});

async function render(node: ReactNode) {
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => { root.render(<LocaleProvider initialLocale="en">{node}</LocaleProvider>); });
	return root;
}
const button = (label: string) => [...dom.document.querySelectorAll("button")].find((node) => node.textContent?.includes(label)) as unknown as HTMLButtonElement;

test("a new project is made with the mode chosen for it, or none; generating cannot be chosen yet", async () => {
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const create = spyOn(editor.project, "createNewProject").mockResolvedValue("new-id");
	const root = await render(<NewProjectButton />);
	try {
		await act(async () => { button("New project").click(); });
		expect(dom.document.body.textContent).toContain("What is this project for?");
		expect(button("Generating").disabled).toBe(true);
		expect(button("Generating").textContent).toContain("Coming soon");
		await act(async () => { button("Editing").click(); });
		expect(create).toHaveBeenCalledWith({ name: "New project", mode: "editing" });
		expect(pushed.at(-1)).toBe("/editor/new-id");
		expect(dom.document.body.textContent).not.toContain("What is this project for?");

		await act(async () => { button("New project").click(); });
		await act(async () => { button("Start without a mode").click(); });
		expect(create).toHaveBeenLastCalledWith({ name: "New project", mode: undefined });
	} finally {
		await act(async () => { root.unmount(); });
		create.mockRestore();
	}
});

test("changing a mode shows the current one and can clear it", async () => {
	const chosen: unknown[] = [];
	const root = await render(<ProjectModeDialog isOpen purpose="change" current="creating" onOpenChange={() => {}} onChoose={(mode) => chosen.push(mode)} />);
	try {
		expect(button("Creating").getAttribute("aria-pressed")).toBe("true");
		expect(button("Editing").getAttribute("aria-pressed")).toBe("false");
		await act(async () => { button("Editing").click(); });
		await act(async () => { button("No mode").click(); });
		expect(chosen).toEqual(["editing", null]);
	} finally {
		await act(async () => { root.unmount(); });
	}
});
