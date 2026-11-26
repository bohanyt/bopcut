import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { EditorCore } from "@/core";
import { audio, scene, t } from "@/timeline/__tests__/compound-fixtures";
import * as audioModule from "@/media/audio";
import { useSoundsStore } from "@/sounds/sounds-store";
import type { SoundEffect } from "@/sounds/types";

const fps = { numerator: 30, denominator: 1 };
const sound: SoundEffect = {
	id: 99,
	name: "Click",
	description: "",
	url: "https://example.com/99",
	previewUrl: "https://example.com/click.mp3",
	duration: 0.5,
	filesize: 1,
	type: "wav",
	channels: 2,
	bitrate: 128,
	bitdepth: 16,
	samplerate: 44100,
	username: "u",
	tags: [],
	license: "CC0",
	created: "2020-01-01",
	downloads: 0,
	rating: 0,
	ratingCount: 0,
};

let dom: Window;
let restoreGlobals: () => void;

beforeEach(() => {
	dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		navigator: dom.navigator,
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
});

afterEach(async () => {
	// fetch and decodeAudioBuffer are spied on below; later test files need the real ones.
	mock.restore();
	EditorCore.reset();
	await dom.close();
	restoreGlobals();
});

test("a sound still downloading when the scene changes is not added to either scene", async () => {
	const sceneA = scene("scene-a", {
		overlay: [],
		main: { id: "a-main", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
		audio: [{ id: "a-audio", name: "Audio", type: "audio", muted: false, elements: [] }],
	});
	const sceneB = scene("scene-b", {
		overlay: [],
		main: { id: "b-main", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
		audio: [{ id: "b-audio", name: "Audio", type: "audio", muted: false, elements: [] }],
	});

	const editor = EditorCore.createRenderOnly();
	editor.audio.dispose();
	const date = new Date(0);
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "Project", duration: t(10), createdAt: date, updatedAt: date },
			settings: { fps, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } },
			currentSceneId: "scene-a",
			scenes: [sceneA, sceneB],
			version: 1,
		},
	});
	editor.scenes.setScenes({ scenes: [sceneA, sceneB], activeSceneId: "scene-a" });
	editor.playback.seek({ time: t(2) });

	let releaseFetch: (() => void) | undefined;
	const fetchGate = new Promise<void>((resolve) => {
		releaseFetch = resolve;
	});

	spyOn(globalThis, "fetch").mockImplementation((async () => {
		await fetchGate;
		return {
			ok: true,
			statusText: "OK",
			arrayBuffer: async () => new ArrayBuffer(16),
		} as Response;
	}) as unknown as typeof fetch);

	spyOn(audioModule, "decodeAudioBuffer").mockResolvedValue({
		length: 128,
		sampleRate: 44100,
		numberOfChannels: 1,
		duration: 128 / 44100,
		getChannelData: () => new Float32Array(128),
	} as unknown as AudioBuffer);

	const addPromise = useSoundsStore.getState().addSoundToTimeline({ sound });
	editor.scenes.setScenes({ scenes: [sceneA, sceneB], activeSceneId: "scene-b" });
	releaseFetch?.();
	expect(await addPromise).toBe(false);

	const scenes = editor.scenes.getScenes();
	expect(scenes.find(({ id }) => id === "scene-a")?.tracks.audio[0].elements).toHaveLength(0);
	expect(scenes.find(({ id }) => id === "scene-b")?.tracks.audio[0].elements).toHaveLength(0);
	expect(editor.command.canUndo()).toBe(false);

	// Without a switch the same download lands on the active scene.
	const second = useSoundsStore.getState().addSoundToTimeline({ sound });
	expect(await second).toBe(true);
	expect(editor.scenes.getActiveScene().tracks.audio.flatMap(({ elements }) => elements)).toHaveLength(1);
});