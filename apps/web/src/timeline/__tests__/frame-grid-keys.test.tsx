import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { invokeAction } from "@/actions/registry";
import { useEditorActions } from "@/actions/use-editor-actions";
import { EditorCore } from "@/core";
import { mediaTime, mediaTimeFromSeconds, TICKS_PER_SECOND, ZERO_MEDIA_TIME } from "@/wasm";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";

const NTSC = { numerator: 30_000, denominator: 1_001 };
const TICKS_PER_FRAME = Math.round((TICKS_PER_SECOND * NTSC.denominator) / NTSC.numerator);

let dom: Window;
let root: Root;
let editor: EditorCore;
let restoreGlobals: () => void;

afterEach(async () => {
	await act(async () => root.unmount());
	EditorCore.reset();
	await dom.close();
	restoreGlobals();
});

function isOnFrameGrid(time: number): boolean {
	return time % TICKS_PER_FRAME === 0;
}

function boot() {
	dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		navigator: dom.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const originals = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
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
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks.main.elements = [video("bg", 0, 20)];
	const date = new Date(0);
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", duration: t(30), createdAt: date, updatedAt: date },
			settings: {
				fps: NTSC,
				canvasSize: { width: 1920, height: 1080 },
				background: { type: "color", color: "#000" },
			},
			currentSceneId: host.id,
			scenes,
			version: 1,
		},
	});
	editor.scenes.setScenes({ scenes, activeSceneId: host.id });
	editor.playback.seek({ time: ZERO_MEDIA_TIME });
}

async function mountActions() {
	boot();
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as unknown as HTMLElement);
	function Actions() {
		useEditorActions();
		return null;
	}
	await act(async () => {
		root.render(<Actions />);
	});
}

test("keyboard seeks land on the 29.97 fps frame grid, and a split there stays on it", async () => {
	await mountActions();
	invokeAction("seek-forward", { seconds: 1 }, "keypress");
	// One second is 29.97 frames: the playhead rounds to frame 30.
	expect(editor.playback.getCurrentTime()).toBe(mediaTime({ ticks: 30 * TICKS_PER_FRAME }));
	invokeAction("frame-step-forward", undefined, "keypress");
	const splitTime = editor.playback.getCurrentTime();
	expect(splitTime).toBe(mediaTime({ ticks: 31 * TICKS_PER_FRAME }));
	invokeAction("split", undefined, "keypress");
	const [left, right] = getHost(editor.scenes.getScenes()).tracks.main.elements;
	expect(isOnFrameGrid(left.duration) && isOnFrameGrid(right.startTime)).toBe(true);
	expect(right.startTime).toBe(splitTime);
	invokeAction("jump-backward", { seconds: 5 }, "keypress");
	expect(editor.playback.getCurrentTime()).toBe(ZERO_MEDIA_TIME);
	invokeAction("goto-end", undefined, "keypress");
	expect(editor.playback.getCurrentTime()).toBe(editor.timeline.getTotalDuration());
});
