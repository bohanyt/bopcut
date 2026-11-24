import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { LocaleProvider } from "@/i18n/provider";
import { BackgroundContent, useBackgroundColorPreview } from "./background";
import { startColorDrag } from "@/components/ui/color-drag";
import { useEditor } from "@/editor/use-editor";
import { EditorCore } from "@/core";
import { cancelInteraction } from "@/editor/cancel-interaction";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import type { TBackground } from "@/project/types";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { appendAlpha, hexToHsv, hsvToHex, parseHexAlpha } from "@/utils/color";

function BackgroundColorDragSurface({
	color,
	onTarget,
}: {
	color: string;
	onTarget: (target: HTMLButtonElement) => void;
}) {
	const ref = useRef<HTMLButtonElement>(null);
	const { timeline } = useEditor();
	const { previewColor, commitColor, readDragBaseline } = useBackgroundColorPreview();
	useLayoutEffect(() => {
		if (ref.current) onTarget(ref.current);
	}, [onTarget]);
	return (
		<button
			ref={ref}
			type="button"
			onPointerDown={(event) => {
				if (event.button !== 0 || !event.isPrimary) return;
				event.preventDefault();
				const target = event.currentTarget;
				const hex = color.replace(/^#/, "");
				const { rgb, alpha } = parseHexAlpha({ hex });
				const [hue] = hexToHsv({ hex: rgb });
				startColorDrag({
					target,
					startEvent: event,
					beginGesture: timeline.beginPreviewGesture,
					readBaseline: () => readDragBaseline(color),
					createColorReader: () => ({ clientX, clientY }) => {
						const rect = target.getBoundingClientRect();
						const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
						const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
						return appendAlpha({
							rgbHex: hsvToHex({ h: hue, s: x, v: 1 - y }),
							alpha,
						});
					},
					onPreview: previewColor,
					onCommit: commitColor,
					onEnd: () => {},
				});
			}}
		/>
	);
}

let dom: Window;
let root: Root;
let restoreGlobals: () => void;

beforeEach(async () => {
	dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		Node: dom.Node,
		HTMLElement: dom.HTMLElement,
		HTMLInputElement: dom.HTMLInputElement,
		getComputedStyle: dom.getComputedStyle.bind(dom),
		requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
		ResizeObserver: dom.ResizeObserver,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const originals = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value,
		});
	}
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	const { createRoot } = await import("react-dom/client");
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	try {
		act(() => root.unmount());
		await dom.close();
	} finally {
		restoreGlobals();
		EditorCore.reset();
	}
});

function render(children: ReactNode) {
	act(() => root.render(<LocaleProvider initialLocale="en">{children}</LocaleProvider>));
}

function setupProject(background: TBackground) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const date = new Date(0);
	editor.project.setActiveProject({
		project: {
			metadata: {
				id: "project",
				name: "Background",
				duration: ZERO_MEDIA_TIME,
				createdAt: date,
				updatedAt: date,
			},
			scenes: [],
			currentSceneId: "scene",
			version: 1,
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				background,
			},
		},
	});
	return editor;
}

function mockPickerRect(target: HTMLButtonElement) {
	spyOn(target, "getBoundingClientRect").mockReturnValue({
		left: 0,
		top: 0,
		width: 200,
		height: 200,
		right: 200,
		bottom: 200,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
}

function pointer(
	target: HTMLButtonElement,
	type: string,
	clientX: number,
	clientY: number,
) {
	target.dispatchEvent(
		new window.PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			isPrimary: true,
			button: 0,
			buttons: type === "pointerup" ? 0 : 1,
			clientX,
			clientY,
		}),
	);
}

test("custom background color drag previews without history and commits once on release", () => {
	const preview = spyOn(effectPreviewService, "renderPreview").mockImplementation(() => {});
	const ready = spyOn(effectPreviewService, "onPreviewImageReady").mockImplementation(
		({ callback }) => {
			callback();
			return () => {};
		},
	);
	const original = { type: "color", color: "#336699" } as const;
	const editor = setupProject(original);
	let dragTarget: HTMLButtonElement | null = null;
	try {
		render(
			<>
				<BackgroundContent />
				<BackgroundColorDragSurface
					color={original.color}
					onTarget={(target) => {
						dragTarget = target;
					}}
				/>
			</>,
		);
		act(() => {});
		const target = dragTarget;
		if (!target) throw new Error("Expected the background color drag surface");
		mockPickerRect(target);
		const getBackground = () => editor.project.getActive()!.settings.background;

		act(() => {
			pointer(target, "pointerdown", 100, 100);
			pointer(target, "pointermove", 160, 40);
			pointer(target, "pointermove", 180, 30);
		});
		const previewed = getBackground();
		expect(previewed).toEqual({ type: "color", color: expect.stringMatching(/^#[0-9a-f]{6}$/i) });
		expect(previewed).not.toEqual(original);
		expect(editor.command.canUndo()).toBe(false);

		act(() => pointer(target, "pointerup", 180, 30));
		expect(getBackground().type).toBe("color");
		expect(editor.command.canUndo()).toBe(true);

		act(() => editor.command.undo());
		expect(getBackground()).toEqual(original);
		expect(editor.command.canUndo()).toBe(false);
	} finally {
		preview.mockRestore();
		ready.mockRestore();
	}
});

test("canceling a custom background color drag restores the color without history", () => {
	const preview = spyOn(effectPreviewService, "renderPreview").mockImplementation(() => {});
	const ready = spyOn(effectPreviewService, "onPreviewImageReady").mockImplementation(
		({ callback }) => {
			callback();
			return () => {};
		},
	);
	const original = { type: "color", color: "#224466" } as const;
	const editor = setupProject(original);
	let dragTarget: HTMLButtonElement | null = null;
	try {
		render(
			<>
				<BackgroundContent />
				<BackgroundColorDragSurface
					color={original.color}
					onTarget={(target) => {
						dragTarget = target;
					}}
				/>
			</>,
		);
		act(() => {});
		const target = dragTarget;
		if (!target) throw new Error("Expected the background color drag surface");
		mockPickerRect(target);
		const getBackground = () => editor.project.getActive()!.settings.background;

		act(() => {
			pointer(target, "pointerdown", 100, 100);
			pointer(target, "pointermove", 160, 40);
		});
		expect(getBackground()).not.toEqual(original);
		expect(editor.command.canUndo()).toBe(false);

		act(() => {
			expect(cancelInteraction()).toBe(true);
		});
		expect(getBackground()).toEqual(original);
		expect(editor.command.canUndo()).toBe(false);
	} finally {
		preview.mockRestore();
		ready.mockRestore();
	}
});