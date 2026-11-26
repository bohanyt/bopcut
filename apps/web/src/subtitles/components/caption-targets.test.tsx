import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { EditorCore as Editor } from "@/core";
import { fixture, getHost, scene, t, text, video } from "@/timeline/__tests__/compound-fixtures";
import { activeWordIndex } from "@/text/caption";
import type { TranscriptionResult } from "@/transcription/types";

let dom: Window;
let root: Root;
let editor: Editor;
let resetEditor: () => void;
let restoreGlobals: () => void;

beforeEach(async () => {
	dom = new Window();
	const globals = {
		window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, Element: dom.Element,
		CustomEvent: dom.CustomEvent, DocumentFragment: dom.DocumentFragment,
		MutationObserver: dom.MutationObserver, HTMLElement: dom.HTMLElement,
		getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
	};
	const originals = Object.entries(globals).map(([key, value]) => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		return [key, descriptor] as const;
	});
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	const { createRoot } = await import("react-dom/client");
	const { EditorCore } = await import("@/core");
	root = createRoot(document.body.appendChild(document.createElement("div")));
	EditorCore.reset();
	editor = EditorCore.createRenderOnly();
	resetEditor = () => EditorCore.reset();
	editor.audio.dispose();
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks.main.elements = [video("video", 0, 4)];
	host.tracks.overlay = [{
		id: "captions", type: "text", name: "Titles", hidden: false,
		elements: [{ ...text("hello world", 0, 2), trimStart: t(1) }],
	}];
	scenes.push(scene("next", { ...host.tracks, overlay: [], audio: [], main: { ...host.tracks.main, elements: [] } }));
	const date = new Date(0);
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "Project", duration: t(4), createdAt: date, updatedAt: date },
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1000, height: 1000 }, background: { type: "color", color: "#000000" } },
		currentSceneId: "main", scenes, version: 1,
	} });
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
});

afterEach(async () => {
	try {
		await act(async () => root.unmount());
		resetEditor();
		await dom.close();
	} finally {
		restoreGlobals();
	}
});

const tracks = () => editor.scenes.getActiveScene().tracks;
async function click(button: Element) {
	await act(async () => button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
}

test("Generate transcript refuses a result after switching scenes", async () => {
	const [media, audio, transcription, { Captions }] = await Promise.all([
		import("@/media/mediabunny"), import("@/media/audio"),
		import("@/services/transcription/service"), import("@/subtitles/components/assets-view"),
	]);
	const pending = Promise.withResolvers<TranscriptionResult>();
	const extract = spyOn(media, "extractTimelineAudio").mockResolvedValue(new Blob());
	const decode = spyOn(audio, "decodeAudioToFloat32").mockResolvedValue({ samples: new Float32Array(16), sampleRate: 16000 });
	const transcribe = spyOn(transcription.transcriptionService, "transcribe").mockReturnValue(pending.promise);
	try {
		await act(async () => root.render(<Captions />));
		const generate = [...document.querySelectorAll("button")].find((button) => button.textContent === "Generate transcript")!;
		await click(generate);
		expect(transcribe).toHaveBeenCalledTimes(1);
		await act(async () => editor.scenes.switchToScene({ sceneId: "next" }));
		await act(async () => pending.resolve({
			text: "From the first scene", language: "en",
			segments: [{ start: 0, end: 1, text: "From the first scene" }],
		}));
		expect(tracks().overlay).toEqual([]);
		expect(editor.command.canUndo()).toBe(false);
		expect(document.body.textContent).toContain("You opened another scene or project.");
	} finally {
		extract.mockRestore();
		decode.mockRestore();
		transcribe.mockRestore();
	}
});

test("enabling word timings on a trimmed title starts at its first visible word", async () => {
	const { CaptionProperties } = await import("@/text/components/caption-properties");
	const fetchPresets = spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
	const current = () => {
		const element = tracks().overlay[0].elements[0];
		if (element.type !== "text") throw new Error("Expected the title");
		return element;
	};
	try {
		await act(async () => root.render(<CaptionProperties element={current()} trackId="captions" />));
		await click(document.querySelector('[role="switch"]')!);
		const caption = current().caption!;
		expect(caption.words.map(({ start, end }) => [start, end])).toEqual([[1, 2], [2, 3]]);
		expect(activeWordIndex(caption.words, 1)).toBe(0);
		editor.command.undo();
		expect(current().caption).toBeUndefined();
		expect(editor.command.canUndo()).toBe(false);
		editor.command.redo();
		expect(current().caption).toEqual(caption);
	} finally {
		fetchPresets.mockRestore();
	}
});
