import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { fixture, getHost, scene, t, video } from "@/timeline/__tests__/compound-fixtures";
import type { CompoundElement } from "@/timeline";
import { upsertPathKeyframe, getKeyframeAtTime } from "@/animation";
import { getParamChannelLayout } from "@/params";
import { getElementParams } from "@/params/registry";

import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";

import { PopoverContent } from "@/components/ui/popover";
import { EditorCore } from "@/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import { LocaleProvider } from "@/i18n/provider";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { Captions } from "@/subtitles/components/assets-view";
import { buildDefaultMaskInstance } from "@/masks";
import { useElementInteraction } from "@/timeline/hooks/element/use-element-interaction";
import * as fontRuntime from "@/fonts/google-fonts";

let restoreGlobals: () => void;
let restoreTabs: () => void;
let dom: Window;
let root: Root;
let editor: EditorCore;
let scenes: ReturnType<typeof fixture>;
const fps = { numerator: 30, denominator: 1 };
const canvasSize = { width: 1920, height: 1080 };

beforeEach(async () => {
	dom = new Window({ url: "http://localhost/" });
	const globals = {
		window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, Element: dom.Element,
		HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, HTMLTextAreaElement: dom.HTMLTextAreaElement,
		MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver, CustomEvent: dom.CustomEvent, NodeFilter: dom.NodeFilter, HTMLButtonElement: dom.HTMLButtonElement, DocumentFragment: dom.DocumentFragment,
		getComputedStyle: dom.getComputedStyle.bind(dom),
		requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const originals = Object.keys(globals).map((key) =>
		[key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	EditorCore.reset();
	editor = EditorCore.createRenderOnly();
	editor.audio.dispose();
	scenes = fixture();
	const { activeTabPerType } = usePropertiesStore.getState();
	restoreTabs = () => usePropertiesStore.setState({ activeTabPerType });
	usePropertiesStore.setState({ activeTabPerType: {} });
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as never);
});

afterEach(async () => {
	try {
		await act(async () => root.unmount());
	} finally {
		EditorCore.reset();
		restoreTabs();
		await dom.close();
		restoreGlobals();
	}
});

function start() {
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "Project", duration: t(10), createdAt: new Date(0), updatedAt: new Date(0) },
		settings: { fps, canvasSize, background: { type: "color", color: "#000000" } },
		currentSceneId: "main",
		scenes,
		version: 1,
	} });
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
}

function select(trackId: string, elementId: string) {
	act(() => editor.selection.setSelectedElements({ elements: [{trackId, elementId}] }));
}
function render(children: ReactNode) {
	act(() => root.render(<LocaleProvider initialLocale="en"><TooltipProvider>{children}</TooltipProvider></LocaleProvider>));
}
function show(trackId: string, elementId: string, type?: string, tabId?: string) {
	select(trackId, elementId);
	if (type && tabId) usePropertiesStore.getState().setActiveTab({ elementType: type, tabId });
	render(<><PropertiesPanel /><TimelineClips /></>);
}
function TimelineClips() {
	const tracks = useEditor((editor) => editor.scenes.getActiveScene().tracks);
	const tracksRef = useRef<HTMLDivElement>(null);
	const interaction = useElementInteraction({ zoomLevel: 1, tracksContainerRef: tracksRef, tracksScrollRef: tracksRef, snappingEnabled: false });
	return <div ref={tracksRef}>{[tracks.main, ...tracks.overlay].flatMap((track) =>
		track.elements.map((element) => <div key={element.id} data-clip={element.id}
			onMouseDown={(event) => interaction.handleElementMouseDown({ event, element, track })} />))}</div>;
}
function rightClickClip(id: string) {
	const clip = document.querySelector(`[data-clip="${id}"]`)!;
	act(() => clip.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 })));
}
function field(selector = "input[inputmode=decimal]") {
	const node = document.querySelector<HTMLInputElement>(selector);
	if (!node) throw new Error("Missing field: " + selector + "\n" + document.body.textContent);
	return node;
}
function type(node: HTMLInputElement, value: string) {
	act(() => {
		const klass = node.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement : dom.HTMLInputElement;
		Object.getOwnPropertyDescriptor(klass.prototype, "value")!.set!.call(node, value);
		node.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
	});
}
function key(node: Element, key: string) {
	act(() => node.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}
function focus(node: HTMLInputElement) {
	act(() => node.focus());
}
function blur(node: HTMLInputElement) {
	act(() => node.blur());
}


test("compound rename binds to the compound where typing began", () => {
	const makeClip = (id: string, at: number): CompoundElement => ({
		...video(id, at, 2), type: "compound", sceneId: id, name: id,
	});
	const main = getHost(scenes);
	scenes.push(scene("First", fixture()[0].tracks, { kind: "compound" }), scene("Second", fixture()[0].tracks, { kind: "compound" }));
	main.tracks.overlay = [{
		id: "compounds", name: "Compounds", type: "video", hidden: false, muted: false,
		elements: [makeClip("First", 0), makeClip("Second", 3)],
	}];
	start();
	show("compounds", "First", "compound", "compound");
	const name = field("input");
	focus(name);
	type(name, "My intro");
	rightClickClip("Second");
	expect(editor.selection.getSelectedElements()[0].elementId).toBe("Second");
	blur(name);
	expect(editor.scenes.getScenes().slice(1).map((scene) => scene.name)).toEqual(["My intro", "Second"]);
	act(() => editor.command.undo());
	expect(editor.scenes.getScenes().slice(1).map((scene) => scene.name)).toEqual(["First", "Second"]);
	expect(editor.command.canUndo()).toBe(false);
});

function beginSubtitleImport() {
	const input = field('input[type="file"]');
	const file = new window.File([], "lines.srt");
	let completeRead!: (value: string) => void;
	file.text = () => new Promise((resolve) => { completeRead = resolve; });
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	act(() => input.dispatchEvent(new window.Event("change", { bubbles: true })));
	expect(completeRead).toBeFunction();
	return () => act(async () => completeRead("1\n00:00:00,100 --> 00:00:01,000\nWords from scene one\n"));
}

test("a subtitle import in the same scene is one Undo step", async () => {
	start();
	render(<Captions />);
	const finishImport = beginSubtitleImport();
	await finishImport();
	const contents = () => editor.scenes.getActiveScene().tracks.overlay
		.flatMap((track) => track.elements.map((element) => element.params.content));
	expect(contents()).toContain("Words from scene one");
	act(() => editor.command.undo());
	expect(contents()).not.toContain("Words from scene one");
	expect(editor.command.canUndo()).toBe(false);
	act(() => editor.command.redo());
	expect(contents()).toContain("Words from scene one");
});

test.each(["scene", "project"] as const)("a subtitle import stops after opening another %s", async (target) => {
	scenes.push(scene("other", fixture()[0].tracks));
	start();
	render(<Captions />);
	const finishImport = beginSubtitleImport();
	if (target === "scene") {
		await act(async () => editor.scenes.switchToScene({ sceneId: "other" }));
	} else {
		const project = editor.project.getActive();
		act(() => editor.project.setActiveProject({
			project: { ...project, metadata: { ...project.metadata, id: "other-project" } },
		}));
	}
	await finishImport();
	expect(document.body.textContent).toContain("You opened another scene or project. The subtitles were not imported.");
	expect(editor.scenes.getScenes().flatMap(({ tracks }) =>
		tracks.overlay.flatMap(({ elements }) => elements.map(({ params }) => params.content)),
	)).not.toContain("Words from scene one");
	expect(editor.command.canUndo()).toBe(false);
});

test("text mask content is saved to its clip when selection moves before blur", async () => {
	const clip = (id: string, at: number) => {
		const mask = buildDefaultMaskInstance({ maskType: "text" });
		if (mask.type !== "text") throw new Error("Expected text mask");
		mask.params.content = id;
		return { ...video(id, at, 2), masks: [mask] };
	};
	getHost(scenes).tracks.main.elements = [clip("a", 0), clip("b", 3)];
	scenes.push(scene("other", fixture()[0].tracks));
	start();
	show("t-main", "a", "video", "masks");
	const input = field("textarea");
	focus(input);
	type(input, "mask typed on a");
	rightClickClip("b");
	expect(editor.selection.getSelectedElements()[0].elementId).toBe("b");
	expect(field("textarea")).not.toBe(input);
	// Navigate away and back. A leftover preview must not be mistaken for a saved edit.
	await act(async () => editor.scenes.switchToScene({ sceneId: "other" }));
	await act(async () => editor.scenes.switchToScene({ sceneId: "main" }));
	const contents = editor.scenes.getActiveScene().tracks.main.elements.map((clip) =>
		clip.type === "video" && clip.masks?.[0]?.type === "text" ? clip.masks[0].params.content : null);
	expect(contents).toEqual(["mask typed on a", "b"]);
});

test("a full expression stays attached to the keyframe that was being edited", () => {
	const propertyPath = "transform.positionX";
	const clip = video("bg", 0, 10);
	const param = getElementParams({ element: clip }).find(({ key }) => key === propertyPath)!;
	const channelLayout = getParamChannelLayout({ param });
	clip.animations = upsertPathKeyframe({
		animations: undefined, propertyPath, time: t(1), value: 10, channelLayout, coerceValue: ({ value }) => value,
	});
	clip.animations = upsertPathKeyframe({
		animations: clip.animations, propertyPath, time: t(2), value: 20, channelLayout, coerceValue: ({ value }) => value,
	});
	getHost(scenes).tracks.main.elements = [clip];
	start();
	act(() => editor.playback.seek({ time: t(1) }));
	show("t-main", "bg", "video", "transform");
	const position = [...document.querySelectorAll<HTMLInputElement>("input[inputmode=decimal]")].find((input) => input.value === "10")!;
	expect(position).toBeDefined();
	let now = 0;
	let advanceFrame!: FrameRequestCallback;
	globalThis.requestAnimationFrame = (callback) => { advanceFrame = callback; return 1; };
	editor.playback.setPlaybackClock(() => now);
	act(() => editor.playback.play());
	focus(position);
	type(position, "100+5");
	act(() => { now = 1; advanceFrame(1000); });
	expect(editor.playback.getCurrentTime()).toBe(t(2));
	expect(document.activeElement).toBe(position);
	key(position, "Enter");
	act(() => editor.playback.pause());
	const animations = editor.scenes.getActiveScene().tracks.main.elements[0].animations;
	expect([t(1), t(2)].map((time) => getKeyframeAtTime({ animations, propertyPath, time })?.value))
		.toEqual([105, 20]);
});

test("a slow font request cannot overwrite a newer font choice on the same mask", async () => {
	const mask = buildDefaultMaskInstance({ maskType: "text" });
	if (mask.type !== "text") throw new Error("Expected text mask");
	getHost(scenes).tracks.main.elements = [{ ...video("bg", 0, 10), masks: [mask] }];
	start();
	const slowFont = "Aardvark Test Font";
	// Render the real popover content without a portal in happy-dom.
	const portal = spyOn(
		PopoverContent as unknown as { render: (props: React.ComponentProps<typeof PopoverContent>) => ReactNode },
		"render",
	).mockImplementation(({ children }) => <div>{children}</div>);
	const atlas = spyOn(fontRuntime, "getCachedFontAtlas").mockReturnValue({
		fonts: { [slowFont]: { x: 0, y: 0, w: 150, ch: 0, s: ["Aardvark Test Font"] } },
	});
	let complete!: () => void;
	const load = spyOn(fontRuntime, "loadFullFont").mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
	try {
		show("t-main", "bg", "video", "masks");
		const trigger = [...document.querySelectorAll<HTMLButtonElement>("button[aria-haspopup=dialog]")]
			.find((button) => button.textContent?.includes(mask.params.fontFamily))!;
		expect(trigger).not.toBeNull();
		await act(async () => trigger.click());
		const slow = document.querySelector<HTMLElement>(`button[aria-label="${slowFont}"]`)!;
		expect(slow).not.toBeNull();
		act(() => slow.click());
		expect(complete).toBeFunction();
		const fast = document.querySelector<HTMLElement>('button[aria-label="Arial"]')!;
		expect(fast).not.toBeNull();
		await act(async () => fast.click());
		const readFont = () => {
			const clip = editor.scenes.getActiveScene().tracks.main.elements[0];
			const updated = clip.type === "video" ? clip.masks?.[0] : undefined;
			return updated?.type === "text" && updated.params.fontFamily;
		};
		expect(readFont()).toBe("Arial");
		await act(async () => complete());
		expect(readFont()).toBe("Arial");
	} finally {
		load.mockRestore();
		atlas.mockRestore();
		portal.mockRestore();
	}
});
