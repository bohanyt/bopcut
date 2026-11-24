import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

mock.module("@/services/renderer/effect-preview", () => ({
	effectPreviewService: { renderPreview: () => {}, onPreviewImageReady: () => () => {}, PREVIEW_SIZE: 160 },
}));
mock.module("@/components/ui/popover", () => {
	const R = require("react");
	const pass = ({ children }: { children?: React.ReactNode }) => children;
	const PopoverContent = R.forwardRef(({ children, onInteractOutside }: { children?: React.ReactNode; onInteractOutside?: (e: { preventDefault: () => void }) => void }, ref: React.Ref<HTMLDivElement>) => {
		const host = R.useRef(null);
		R.useLayoutEffect(() => {
			const onDown = (event: PointerEvent) => {
				if (host.current?.contains(event.target as Node)) return;
				onInteractOutside?.({ preventDefault: () => event.preventDefault() });
			};
			document.addEventListener("pointerdown", onDown, true);
			return () => document.removeEventListener("pointerdown", onDown, true);
		}, [onInteractOutside]);
		return R.createElement("div", { ref: (node: HTMLDivElement | null) => { host.current = node; if (typeof ref === "function") ref(node); else if (ref) ref.current = node; } }, children);
	});
	return { Popover: pass, PopoverTrigger: pass, PopoverContent, PopoverClose: pass, PopoverAnchor: pass };
});

import { ColorPickerContent } from "@/components/ui/color-picker";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { LocaleProvider } from "@/i18n/provider";
import { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { useBackgroundColorPreview } from "./background";

let dom: Window, root: Root, restoreGlobals: () => void;

beforeEach(async () => {
	dom = new Window();
	const globals = { window: dom, document: dom.document, Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true };
	const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	restoreGlobals = () => { for (const [key, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key); };
	const { createRoot } = await import("react-dom/client");
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => { act(() => root.unmount()); await dom.close(); restoreGlobals(); EditorCore.reset(); });

function render(children: ReactNode) { act(() => root.render(<LocaleProvider initialLocale="en">{children}</LocaleProvider>)); }

function setupBlur() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const blur = { type: "blur", blurIntensity: 12 } as const;
	const date = new Date(0);
	editor.project.setActiveProject({ project: { metadata: { id: "p", name: "P", duration: ZERO_MEDIA_TIME, createdAt: date, updatedAt: date }, scenes: [], currentSceneId: "s", version: 1, settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 }, background: blur } } });
	return { editor, blur };
}

function Fixture({ swatch }: { swatch: string }) {
	const { timeline } = useEditor();
	const { previewColor, commitColor, readDragBaseline } = useBackgroundColorPreview();
	return <Popover defaultOpen><PopoverTrigger asChild><button type="button">Custom</button></PopoverTrigger><ColorPickerContent beginDragGesture={timeline.beginPreviewGesture} readDragBaseline={() => readDragBaseline(swatch)} value={swatch.replace(/^#/, "").toUpperCase()} onChange={previewColor} onChangeEnd={commitColor} /></Popover>;
}

function rect(btn: HTMLButtonElement) {
	btn.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function drag(btn: HTMLButtonElement, type: string, x: number, y: number) {
	act(() => btn.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y })));
}

test("custom background popover gestures preserve blur history and commits", () => {
	const { editor, blur } = setupBlur();
	render(<Fixture swatch={DEFAULT_BACKGROUND_COLOR} />);
	expect(document.querySelector('button[style*="linear-gradient"]')).not.toBeNull();
	const btn = document.querySelector<HTMLButtonElement>('button[style*="linear-gradient"]')!;
	rect(btn);
	drag(btn, "pointerdown", 160, 40); drag(btn, "pointermove", 160, 40); drag(btn, "pointerup", 160, 40);
	const committed = editor.project.getActive().settings.background;
	expect(committed.type).toBe("color");
	act(() => editor.command.undo());
	expect(editor.project.getActive().settings.background).toEqual(blur);
	act(() => editor.command.redo());
	expect(editor.project.getActive().settings.background).toEqual(committed);
	rect(btn);
	drag(btn, "pointerdown", 120, 80); drag(btn, "pointermove", 40, 80); drag(btn, "pointercancel", 40, 80);
	expect(editor.project.getActive().settings.background).toEqual(committed);
	const input = document.querySelector("input")!;
	act(() => input.focus());
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set!;
	act(() => { setter.call(input, "abcdef"); input.dispatchEvent(new window.Event("input", { bubbles: true })); });
	const outside = document.createElement("button");
	document.body.append(outside);
	act(() => outside.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 2, button: 0, isPrimary: true })));
	expect(editor.project.getActive().settings.background).toEqual({ type: "color", color: "#abcdef" });
});