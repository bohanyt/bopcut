import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import { audio, fixture, scene, t } from "@/timeline/__tests__/compound-fixtures";
import { runMigrations } from "@/actions/keybindings/migrations";
import { isStorageQuotaExceededError } from "@/services/storage/quota";
import type { MicrophoneInput } from "./microphone";
import type { PointerEvent as ReactPointerEvent } from "react";
import { PlayheadController } from "@/timeline/controllers/playhead-controller";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { PlaceTakeCommand, placeTake } = await import("./take-placement");
const { VoiceOver } = await import("./voice-over");

const asset = (number: number, duration = 1) => ({
	mediaId: `recording-${number}`, name: `Voice ${number}`, duration: t(duration),
});

function setup({ empty = false } = {}) {
	const tracks = fixture()[0].tracks;
	const scenes = [scene("main", empty ? {
		main: { ...tracks.main, elements: [] }, overlay: [], audio: [],
	} : tracks)];
	const editor = EditorCore.getInstance();
	editor.save.stop();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "voice-test", name: "Recorder", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes, currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}

afterEach(() => EditorCore.reset());

test("Shift+R is added to stored shortcuts only when unbound", () => {
	const state = { isCustomized: true, keybindings: { space: "toggle-play" } };
	expect(runMigrations({ state, fromVersion: 8 })).toEqual({
		...state, keybindings: { ...state.keybindings, "shift+r": "record-voice-over" },
	});
	const custom = { ...state, keybindings: { ...state.keybindings, "shift+r": "undo" } };
	expect(runMigrations({ state: custom, fromVersion: 8 })).toEqual(custom);
});

test("a full disk is reported as a storage capacity error", () => {
	expect(isStorageQuotaExceededError({ error: new Error("Storage failed (400): ENOSPC") })).toBe(true);
});

test("insert, retake and take swap each undo in one step with ripple enabled", () => {
	const editor = setup();
	editor.command.isRippleEnabled = true;
	const read = () => editor.scenes.getActiveScene().tracks;
	const original = read();
	// There is music over this interval. Both takes must use a free track.
	const startTime = t(2);
	const first = placeTake({ tracks: original, take: asset(1), startTime, candidates: [] })!;
	const apply = (before: typeof original, after: typeof original) =>
		editor.command.execute({ command: new PlaceTakeCommand({ before, after }) });
	apply(original, first.tracks);
	expect(first.anchor.trackId).not.toBe("t-music");
	expect(first.anchor.element.startTime).toBe(startTime);
	editor.command.undo();
	expect(read()).toEqual(original);
	expect(editor.command.canUndo()).toBe(false);
	editor.command.redo();
	const before = read();
	const second = placeTake({ tracks: before, take: asset(2, 2), startTime, candidates: [first.anchor] })!;
	expect(second.anchor.trackId).toBe(first.anchor.trackId);
	apply(before, second.tracks);
	expect(read().audio.find(({ id }) => id === "t-music")?.elements).toEqual(original.audio[0].elements);
	editor.command.undo();
	expect(read()).toEqual(before);
	editor.command.redo();
	const beforeSwap = read();
	const swap = placeTake({ tracks: beforeSwap, take: asset(1), startTime, candidates: [second.anchor, first.anchor] })!;
	apply(beforeSwap, swap.tracks);
	expect(swap.anchor.element.mediaId).toBe("recording-1");
	editor.command.undo();
	expect(read()).toEqual(beforeSwap);
});

test("a longer take finds a free track; moving, trimming, splitting or deleting protects the prior edit", () => {
	const original = fixture()[0].tracks;
	const startTime = t(0);
	const first = placeTake({ tracks: original, take: asset(1), startTime, candidates: [], preferredTrackId: "t-music" })!;
	expect(first.anchor.trackId).toBe("t-music");
	const longer = placeTake({ tracks: first.tracks, take: asset(2, 2), startTime, candidates: [first.anchor] })!;
	expect(longer.anchor.trackId).not.toBe(first.anchor.trackId);
	expect(longer.tracks.audio.find(({ id }) => id === "t-music")?.elements).toEqual(original.audio[0].elements);
	const { element } = first.anchor;
	const edits = [
		[{ ...element, startTime: t(4) }],
		[{ ...element, trimStart: t(.25), duration: t(.75) }],
		[{ ...element, duration: t(.5) }, { ...element, id: "split", startTime: t(.5), duration: t(.5) }],
		[],
	];
	for (const changed of edits) {
		const tracks = { ...original, audio: [{ ...original.audio[0], elements: [...changed, audio("music", 1.5, 2)] }] };
		const result = placeTake({ tracks, take: asset(2), startTime, candidates: [first.anchor], preferredTrackId: "t-music" })!;
		expect(result.anchor.element.id).not.toBe(element.id);
		for (const edit of changed) expect(result.tracks.audio.flatMap(({ elements }) => elements).includes(edit)).toBe(true);
	}
});

test("a new take skips muted tracks, while a retake keeps its own track", () => {
	const original = fixture()[0].tracks;
	const muted = { ...original, audio: original.audio.map((track) => ({ ...track, muted: true })) };
	const first = placeTake({ tracks: muted, take: asset(1), startTime: t(20), candidates: [], preferredTrackId: "t-music" })!;
	expect(muted.audio.some(({ id }) => id === first.anchor.trackId)).toBe(false);
	const track = first.tracks.audio.find(({ id }) => id === first.anchor.trackId)!;
	expect(track.muted).toBe(false);
	const reviewed = { ...first.tracks, audio: first.tracks.audio.map((item) => item === track ? { ...track, muted: true } : item) };
	const second = placeTake({ tracks: reviewed, take: asset(2), startTime: t(20), candidates: [first.anchor] })!;
	expect(second.anchor.trackId).toBe(first.anchor.trackId);
});

function harness({ samples = Int16Array.of(500, 10, -500), failImport = false } = {}) {
	const editor = setup({ empty: true });
	let onLost = () => {};
	const close = mock(() => {});
	const mic: MicrophoneInput = {
		sampleRate: 48000, inputLatency: 0, outputLatency: 0, deviceId: "",
		getTime: () => 1,
		start: (callback) => callback(48000),
		stop: async () => { close(); return { chunks: [samples], complete: true }; },
		close,
	};
	const manager = new VoiceOver(editor, async (_options, _signal, _level, lost) => {
		onLost = lost;
		return mic;
	}, 1, 20);
	const assets: MediaAsset[] = [];
	spyOn(editor.media, "getAssets").mockImplementation(() => assets);
	const importFile = spyOn(editor.media, "importFile").mockImplementation(async ({ file, name }) => {
		if (failImport) return null;
		const imported: MediaAsset = { file, name: name ?? file.name, id: crypto.randomUUID(), type: "audio" };
		assets.push(imported);
		return imported;
	});

	function waitFor(predicate: () => boolean): Promise<void> {
		if (predicate()) return Promise.resolve();
		return new Promise((resolve) => {
			const unsubscribe = manager.subscribe(() => {
				if (!predicate()) return;
				unsubscribe();
				resolve();
			});
		});
	}

	async function start(record = true) {
		manager.openSetup();
		await waitFor(() => manager.getSnapshot().ready);
		manager.record();
		if (record) await waitFor(() => manager.getSnapshot().phase === "recording");
	}
	return { editor, manager, close, start, importFile, onLost: () => onLost() };
}

test("count-in cancellation releases the mic and creates no timeline history", async () => {
	const { editor, manager, close, start, importFile } = harness();
	try {
		editor.playback.setVolume({ volume: .35 });
		await start(false);
		manager.stop();
		expect(close).toHaveBeenCalled();
		expect(editor.playback.getOutputVolume()).toBe(.35);
		expect(importFile).not.toHaveBeenCalled();
		expect(editor.command.canUndo()).toBe(false);
	} finally { manager.dispose(); }
});

test("a coalesced scrub seek interrupts the recorder through PlaybackManager", async () => {
	const { editor, manager, start, importFile } = harness();
	const events = new EventTarget();
	const target = Object.assign(new EventTarget(), {
		setPointerCapture() {},
		hasPointerCapture: () => true,
		releasePointerCapture() {},
	});
	const frames = new Map<number, FrameRequestCallback>();
	let nextFrame = 0;
	const globals = {
		window: events, document: new EventTarget(),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++nextFrame, callback);
			return nextFrame;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
	};
	const descriptors = Object.entries(globals).map(([key, value]) => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		Object.defineProperty(globalThis, key, { value, configurable: true });
		return [key, descriptor] as const;
	});
	const controller = new PlayheadController({ configRef: { current: {
		zoomLevel: 1,
		getDuration: () => editor.timeline.getTotalDuration(),
		getProjectSession: () => editor.project.getSession(),
		getSceneId: () => editor.scenes.getActiveScene().id,
		getCurrentTime: () => editor.playback.getCurrentTime(),
		getActiveProjectFps: () => editor.project.getActive().settings.fps,
		isShiftHeld: () => true,
		isSnappingEnabled: () => true,
		getIsPlaying: () => editor.playback.getIsPlaying(),
		getRulerEl: () => ({ getBoundingClientRect: () => ({ left: 0 }) }) as HTMLDivElement,
		getRulerScrollEl: () => null,
		getTracksScrollEl: () => null,
		getPlayheadEl: () => null,
		getSceneTracks: () => editor.scenes.getActiveScene().tracks,
		getSceneBookmarks: () => [],
		seek: (time) => editor.playback.seek({ time }),
		setScrubbing: (isScrubbing) => editor.playback.setScrubbing({ isScrubbing }),
		setTimelineViewState: () => {},
	} } });
	try {
		controller.onRulerPointerDown({
			target, currentTarget: target, clientX: 0, button: 0, buttons: 1,
			pointerId: 1, isPrimary: true, preventDefault() {},
		} as unknown as ReactPointerEvent);
		await start();
		const interrupt = spyOn(editor.playback, "seek");
		events.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: 50, buttons: 1, pointerId: 1 }));
		// The empty fixture clamps the seek back to zero. Give the queued move
		// a different live time so the controller emits an explicit seek.
		const readTime = spyOn(editor.playback, "getCurrentTime").mockReturnValueOnce(t(0.5));
		expect(manager.getSnapshot().phase).toBe("recording");
		for (const [id, frame] of [...frames]) {
			frames.delete(id);
			frame(0);
		}
		readTime.mockRestore();
		expect(interrupt).toHaveBeenCalledTimes(1);
		expect(manager.getSnapshot().phase).toBe("saving");
		await manager.stop();
		expect(manager.getSnapshot().phase).toBe("review");
		expect(importFile).toHaveBeenCalledTimes(1);
	} finally {
		controller.destroy();
		manager.dispose();
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test.each(["stop", "pause", "seek", "unplug", "navigation", "empty", "silent", "import failure", "originally muted"] as const)(
	"%s releases recording mute and keeps valid audio or a recoverable WAV",
	async (exit) => {
		const { editor, manager, close, start, importFile, onLost } = harness({
			samples: exit === "empty" ? new Int16Array() : exit === "silent" ? new Int16Array(8) : undefined,
			failImport: exit === "import failure",
		});
		try {
			const { playback } = editor;
			const reveal = spyOn(playback, "revealPlayhead");
			playback.setVolume({ volume: .35 });
			if (exit === "originally muted") playback.mute();
			await start();
			expect(playback.getOutputVolume()).toBe(0);
			expect(playback.getIsPlaying()).toBe(false);
			if (exit === "pause") playback.pause();
			if (exit === "seek") playback.seek({ time: t(0) });
			if (exit === "unplug") onLost();
			if (exit === "navigation") await manager.finishForNavigation();
			else await manager.stop();
			expect(close).toHaveBeenCalled();
			expect(playback.getOutputVolume()).toBe(exit === "originally muted" ? 0 : .35);
			if (exit === "originally muted") {
				expect(playback.isMuted()).toBe(true);
				playback.unmute();
				expect(playback.getVolume()).toBe(.35);
			}
			if (exit === "empty" || exit === "silent") {
				expect(importFile).not.toHaveBeenCalled();
				expect(manager.getSnapshot().phase).toBe(exit === "silent" ? "recovery" : "idle");
			} else if (exit === "import failure") {
				expect(manager.getSnapshot().phase).toBe("recovery");
				expect(manager.canRetry()).toBe(true);
			} else {
				expect(manager.getSnapshot().phase).toBe("review");
				expect(editor.scenes.getActiveScene().tracks.audio[0].elements[0].startTime).toBe(t(0));
				expect(reveal).toHaveBeenCalled();
			}
		} finally { manager.dispose(); }
	},
);

test("the mic toggle during review keeps the take instead of stacking a second recording", async () => {
	const { editor, manager, start, importFile } = harness();
	try {
		await start();
		await manager.stop();
		expect(manager.getSnapshot().phase).toBe("review");
		manager.toggle();
		expect(manager.getSnapshot().phase).toBe("idle");
		expect(importFile).toHaveBeenCalledTimes(1);
		expect(editor.scenes.getActiveScene().tracks.audio.flatMap((track) => track.elements).length).toBe(1);
		manager.toggle();
		expect(manager.getSnapshot().phase).toBe("setup");
	} finally { manager.dispose(); }
});

test("storage that never answers releases navigation, and retry waits for the running write", async () => {
	const { editor, manager, close, start, importFile } = harness();
	try {
		await start();
		const importNow = importFile.getMockImplementation()!;
		let finishWrite = () => {};
		importFile.mockImplementation((params) => new Promise((resolve) => {
			finishWrite = () => resolve(importNow(params));
		}));
		await manager.finishForNavigation();
		expect(close).toHaveBeenCalled();
		expect(manager.getSnapshot().phase).toBe("recovery");
		expect(manager.canRetry()).toBe(true);
		expect(editor.command.canUndo()).toBe(false);
		await manager.retryTake();
		expect(manager.getSnapshot().phase).toBe("recovery");
		const retry = manager.retryTake();
		finishWrite();
		await retry;
		expect(importFile).toHaveBeenCalledTimes(1);
		expect(manager.getSnapshot().phase).toBe("review");
		expect(editor.scenes.getActiveScene().tracks.audio[0].elements.length).toBe(1);
	} finally { manager.dispose(); }
});

test("natural playback end leaves the recording open, while a scope change cannot insert it into the new scene", async () => {
	const { editor, manager, start, importFile } = harness();
	try {
		await start();
		editor.playback.finishAtTimelineEnd();
		expect(manager.getSnapshot().phase).toBe("recording");
		const current = editor.scenes.getActiveScene();
		const next = scene("other", current.tracks);
		editor.scenes.setScenes({ scenes: [current, next], activeSceneId: next.id });
		await manager.stop();
		expect(importFile).not.toHaveBeenCalled();
		expect(manager.getSnapshot().phase).toBe("recovery");
		expect(manager.canRetry()).toBe(false);
		expect(editor.scenes.getActiveScene().tracks.audio).toEqual([]);
		expect(editor.playback.getOutputVolume()).toBe(1);
	} finally { manager.dispose(); }
});
