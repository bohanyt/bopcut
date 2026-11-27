import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { fixture, getHost, video } from "@/timeline/__tests__/compound-fixtures";
import type { VideoElement } from "@/timeline";

// The Radix dialog does not render in happy-dom: a plain stand-in shows its content while open.
const realDialog = { ...(await import("@/components/ui/dialog")) };
const plain = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@/components/ui/dialog", () => ({
	...realDialog,
	Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? <div>{children}</div> : null),
	DialogBody: plain, DialogContent: plain, DialogHeader: plain, DialogTitle: plain, DialogDescription: plain, DialogFooter: plain,
}));
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { LocaleProvider } = await import("@/i18n/provider");
const { applySplitLayout } = await import("../apply-split-layout");
const { SplitLayoutDialog } = await import("../components/split-layout-dialog");

const dom = new Window();
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

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks.main.elements = [video("stream", 0, 30)];
	host.tracks.overlay = [];
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
		scenes, currentSceneId: "main",
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" } },
	} as never });
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.media.setAssets({ assets: [{ id: "media-stream", name: "Stream", type: "video", width: 1920, height: 1080, file: new File(["v"], "v.mp4") }] });
	return { editor, clip: { trackId: host.tracks.main.id, elementId: "stream" } };
}

test("the layout makes a landscape canvas vertical and splits the clip, in one Undo step", () => {
	const { editor, clip } = setup();
	const facecam = applySplitLayout(editor, { clip, facecam: { x: 0.02, y: 0.62, width: 0.22, height: 0.34 }, split: 0.6 });
	expect(facecam).not.toBeNull();
	expect(editor.project.getActive().settings.canvasSize).toEqual({ width: 1080, height: 1920 });
	const tracks = editor.scenes.getActiveScene().tracks;
	expect(tracks.overlay[0].elements.map(({ id }) => id)).toEqual([facecam!.elementId]);
	expect((tracks.main.elements[0] as VideoElement).masks?.[0].params).toMatchObject({ canvasLocked: true });
	expect(editor.selection.getSelectedElements()).toEqual([facecam!]);
	editor.command.undo();
	expect(editor.project.getActive().settings.canvasSize).toEqual({ width: 1920, height: 1080 });
	expect(editor.scenes.getActiveScene().tracks.overlay).toEqual([]);
	expect((editor.scenes.getActiveScene().tracks.main.elements[0] as VideoElement).masks).toBeUndefined();
});

test("a clip with no known size is not split", () => {
	const { editor, clip } = setup();
	editor.media.setAssets({ assets: [{ id: "media-stream", name: "Stream", type: "video", file: new File(["v"], "v.mp4") }] });
	expect(applySplitLayout(editor, { clip, facecam: { x: 0, y: 0, width: 0.3, height: 0.3 } })).toBeNull();
	expect(editor.command.canUndo()).toBe(false);
});

test("the dialog takes the facecam box drawn on the still and the game's height", async () => {
	const chosen: unknown[] = [];
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
	await act(async () => {
		root.render(<LocaleProvider initialLocale="en">
			<SplitLayoutDialog still="still.jpg" aspect={16 / 9} makesVertical onCancel={() => {}} onConfirm={(choice) => chosen.push(choice)} />
		</LocaleProvider>);
	});
	try {
		expect(dom.document.body.textContent).toContain("The canvas becomes 9:16");
		const picture = dom.document.querySelector("[role='application']") as unknown as HTMLElement;
		picture.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 225, right: 400, bottom: 225, x: 0, y: 0, toJSON() {} });
		const pointer = (type: string, x: number, y: number) => new dom.PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 });
		await act(async () => { picture.dispatchEvent(pointer("pointerdown", 300, 20) as never); });
		await act(async () => { picture.dispatchEvent(pointer("pointermove", 380, 110) as never); });
		await act(async () => { picture.dispatchEvent(pointer("pointerup", 380, 110) as never); });
		const slider = dom.document.querySelector("input[type='range']") as unknown as HTMLInputElement;
		await act(async () => {
			Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(slider, "0.55");
			slider.dispatchEvent(new dom.Event("input", { bubbles: true }) as never);
		});
		const make = [...dom.document.querySelectorAll("button")].find((node) => node.textContent === "Make layout") as unknown as HTMLButtonElement;
		await act(async () => { make.click(); });
		expect(chosen).toHaveLength(1);
		const [{ facecam, split }] = chosen as { facecam: Record<string, number>; split: number }[];
		const expected = { x: 0.75, y: 20 / 225, width: 0.2, height: 0.4 };
		for (const key of Object.keys(expected) as (keyof typeof expected)[]) expect(facecam[key]).toBeCloseTo(expected[key], 9);
		expect(split).toBe(0.55);
	} finally {
		await act(async () => { root.unmount(); });
	}
});
