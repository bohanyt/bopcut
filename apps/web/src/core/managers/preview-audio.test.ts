import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { AudioBufferSink, Input, InputAudioTrack, type WrappedAudioBuffer } from "mediabunny";
import { collectAudioClips, decodeAudioToFloat32 } from "@/media/audio";
import type { AudioElement, LibraryAudioElement, UploadAudioElement } from "@/timeline";
import { scene, t } from "@/timeline/__tests__/compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { resolve, promise };
}

function packet(timestamp: number, duration: number): WrappedAudioBuffer {
	return { timestamp, duration, buffer: { duration } as AudioBuffer };
}

function libraryClip(overrides: Partial<LibraryAudioElement> = {}): LibraryAudioElement {
	return {
		id: "library",
		type: "audio",
		sourceType: "library",
		sourceUrl: "https://example.test/sound.mp3",
		name: "Library sound",
		startTime: t(0),
		duration: t(20),
		trimStart: t(0),
		trimEnd: t(0),
		params: { volume: 0 },
		...overrides,
	};
}

function uploadedClip(overrides: Partial<UploadAudioElement> = {}): UploadAudioElement {
	return {
		id: "upload",
		type: "audio",
		sourceType: "upload",
		mediaId: "upload",
		name: "Uploaded sound",
		startTime: t(0),
		duration: t(20),
		trimStart: t(0),
		trimEnd: t(0),
		params: { volume: 0 },
		...overrides,
	};
}

function setup(clip: AudioElement = libraryClip()) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const activeScene = scene("main", {
		overlay: [],
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
		audio: [{ id: "audio", name: "Audio", type: "audio", muted: false, elements: [clip] }],
	});
	editor.project.setActiveProject({
		project: {
			metadata: { id: "project", name: "Project", duration: t(0), createdAt: new Date(0), updatedAt: new Date(0) },
			scenes: [activeScene],
			currentSceneId: activeScene.id,
			settings: {
				fps: { numerator: 30, denominator: 1 },
				canvasSize: { width: 1920, height: 1080 },
				canvasSizeMode: "preset",
				lastCustomCanvasSize: null,
				originalCanvasSize: null,
				background: { type: "color", color: "#000000" },
			},
			version: 0,
		},
	});
	editor.scenes.setScenes({ scenes: [activeScene], activeSceneId: activeScene.id });
	if (clip.sourceType === "upload") {
		editor.media.setAssets({
			assets: [{ id: clip.mediaId, name: clip.name, type: "audio", file: new File(["audio"], "audio.wav") }],
		});
	}
	return { editor, tracks: activeScene.tracks };
}

const restore: Array<() => void> = [];

function stubGlobal(key: string, value: unknown) {
	const original = Object.getOwnPropertyDescriptor(globalThis, key);
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	restore.push(() => {
		if (original) Object.defineProperty(globalThis, key, original);
		else Reflect.deleteProperty(globalThis, key);
	});
}

afterEach(() => {
	const { playback } = EditorCore.getInstance();
	if (playback.getIsPlaying()) playback.pause();
	EditorCore.reset();
	for (const restoreStub of restore.splice(0).reverse()) restoreStub();
});

function fakeAudio() {
	let raf: FrameRequestCallback | undefined;
	let wallTimeMs = 1_000;
	const starts: Array<{ when: number; offset?: number; duration?: number; rate: number }> = [];
	const gains: Array<{ time: number; value: number }> = [];
	const disconnect = mock(() => {});
	const stops = mock(() => {});
	const setInterval = mock(() => 1);
	const clearInterval = mock(() => {});
	const audio = {
		currentTime: 10,
		state: "suspended",
		destination: {},
		resume: mock(async () => { audio.state = "running"; }),
		suspend: mock(async () => { audio.state = "suspended"; }),
		close: mock(async () => { audio.state = "closed"; }),
		decodeAudioData: mock(async () => ({
			length: 2,
			numberOfChannels: 2,
			sampleRate: 16_000,
			getChannelData: (channel: number) => new Float32Array(channel === 0 ? [0.5, 1] : [0.5, 0]),
		})),
		createGain: () => {
			const record = (value: number, time: number) => { gains.push({ value, time }); };
			return {
				connect() {},
				disconnect,
				gain: { value: 1, setValueAtTime: record, linearRampToValueAtTime: record },
			};
		},
		createDynamicsCompressor: () => ({
			threshold: { value: 0 },
			knee: { value: 0 },
			ratio: { value: 0 },
			attack: { value: 0 },
			release: { value: 0 },
			connect() {},
		}),
		createBufferSource: () => {
			const playbackRate = { value: 1 };
			return {
				playbackRate,
				connect() {},
				disconnect,
				stop: stops,
				addEventListener() {},
				start(when: number, offset?: number, duration?: number) {
					starts.push({ when, offset, duration, rate: playbackRate.value });
				},
			};
		},
	};

	stubGlobal("window", { AudioContext: class { constructor() { return audio; } }, setInterval, clearInterval });
	stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		raf = callback;
		return 1;
	});
	stubGlobal("cancelAnimationFrame", () => { raf = undefined; });
	const now = spyOn(performance, "now").mockImplementation(() => wallTimeMs);
	restore.push(() => now.mockRestore());
	const frame = (elapsedWallMs: number) => {
		wallTimeMs += elapsedWallMs;
		raf?.(wallTimeMs);
	};
	return { audio, starts, gains, frame, stops, disconnect, setInterval };
}

function stubFetch(...responses: Promise<Response>[]) {
	const fetch = mock(async () =>
		responses.shift() ?? new Response("audio"),
	);
	stubGlobal("fetch", fetch);
	return fetch;
}

function stubDecoder(
	buffers: (start: number, end: number) => AsyncGenerator<WrappedAudioBuffer, void, unknown>,
) {
	const track = Object.create(InputAudioTrack.prototype) as InputAudioTrack;
	const getTrack = spyOn(Input.prototype, "getPrimaryAudioTrack").mockResolvedValue(track);
	const decode = spyOn(AudioBufferSink.prototype, "buffers").mockImplementation(
		(start = 0, end = Infinity) => buffers(start, end),
	);
	restore.push(() => getTrack.mockRestore(), () => decode.mockRestore());
	return { decode, getTrack, track };
}

const flush = () => Bun.sleep(0);

test("a library clip is collected in seconds, including both trims", async () => {
	const { tracks } = setup(libraryClip({ startTime: t(5), duration: t(2), trimStart: t(0.25), trimEnd: t(0.75) }));
	stubFetch();

	const clips = await collectAudioClips({ tracks, mediaAssets: [] });
	expect(clips).toHaveLength(1);
	expect(clips[0]).toMatchObject({ startTime: 5, duration: 2, trimStart: 0.25, trimEnd: 0.75 });
});

test("a pending start cannot replace a later seek or queue work after pause", async () => {
	const { editor } = setup();
	const { starts, setInterval } = fakeAudio();
	const original = deferred<Response>();
	const seek = deferred<Response>();
	const stopped = deferred<Response>();
	const fetch = stubFetch(original.promise, seek.promise, stopped.promise);
	const { decode } = stubDecoder(async function* (start) { yield packet(start, 0.1); });

	editor.playback.play();
	await flush();
	editor.playback.seek({ time: t(3) });
	await flush();
	expect(fetch).toHaveBeenCalledTimes(2);
	seek.resolve(new Response("new"));
	await flush();
	expect(decode.mock.calls[0][0]).toBeCloseTo(3);
	expect(starts).toHaveLength(1);

	original.resolve(new Response("old"));
	await flush();
	expect(starts).toHaveLength(1);
	expect(editor.playback.getCurrentTime()).toBe(t(3));

	editor.playback.seek({ time: t(6) });
	await flush();
	editor.playback.pause();
	stopped.resolve(new Response("stopped"));
	await flush();
	expect(starts).toHaveLength(1);
	expect(setInterval).not.toHaveBeenCalled();
});

test("startup catches up to the unrounded playhead and subsequent frames follow the audio clock", async () => {
	const { editor } = setup(libraryClip({ duration: t(120) }));
	const { audio, starts, frame } = fakeAudio();
	const resumed = deferred<void>();
	audio.resume.mockImplementation(async () => {
		await resumed.promise;
		audio.state = "running";
	});
	const library = deferred<Response>();
	stubFetch(library.promise);
	const { decode } = stubDecoder(async function* () { yield packet(0.5, 0.2); });

	editor.playback.play();
	frame(400);
	resumed.resolve();
	await flush();
	frame(115);
	library.resolve(new Response("audio"));
	await flush();
	expect(decode.mock.calls[0][0]).toBeCloseTo(0.515, 6);
	expect(starts[0].offset).toBeCloseTo(0.015, 6);
	expect(starts[0].when).toBe(10);

	audio.currentTime = 70;
	frame(62_000);
	expect(editor.playback.getCurrentTime()).toBe(t(60.5));
});

test("streaming clips cut spanning packets at both ends and place fade corners on the timeline", async () => {
	const { editor } = setup(uploadedClip({
		startTime: t(0.5),
		duration: t(0.4),
		trimStart: t(1),
		params: { volume: 0, fadeIn: 0.04, fadeOut: 0.09 },
	}));
	const { starts, gains } = fakeAudio();
	const { decode } = stubDecoder(async function* () {
		yield packet(0.9, 0.2);
		yield packet(1.3, 0.2);
	});

	editor.playback.play();
	await flush();

	expect(decode.mock.calls[0]).toEqual([1, 1.4]);
	expect(starts).toHaveLength(2);
	expect(starts[0].when).toBeCloseTo(10.5);
	expect(starts[0].offset).toBeCloseTo(0.1);
	expect(starts[0].duration).toBeCloseTo(0.1);
	expect(starts[1].when).toBeCloseTo(10.8);
	expect(starts[1].offset).toBeCloseTo(0);
	expect(starts[1].duration).toBeCloseTo(0.1);
	const gainAt = (time: number) => gains.find((gain) => Math.abs(gain.time - time) < 1e-8)?.value;
	expect(gainAt(10.5)).toBe(0);
	expect(gainAt(10.54)).toBeCloseTo(1, 6);
	expect(gainAt(10.81)).toBeCloseTo(1, 6);
	expect(gainAt(10.9)).toBeCloseTo(0, 6);
});

test("late retimed packets skip elapsed source seconds and discard expired packets", async () => {
	const { editor } = setup(uploadedClip({ retime: { rate: 2, maintainPitch: false } }));
	const { audio, starts } = fakeAudio();
	stubDecoder(async function* () {
		audio.currentTime = 10.15;
		yield packet(0, 0.2);
		yield packet(0.2, 0.4);
	});

	editor.playback.play();
	await flush();

	expect(starts).toHaveLength(1);
	expect(starts[0].rate).toBe(2);
	expect(starts[0].when).toBe(10.15);
	expect(starts[0].offset).toBeCloseTo(0.1, 6);
	expect(starts[0].duration).toBeCloseTo(0.3, 6);
});

test("rounding the preview frame to the end does not stop the last audio samples early", async () => {
	const { editor } = setup(uploadedClip({ duration: t(1) }));
	const { audio, frame, stops } = fakeAudio();
	stubDecoder(async function* () { yield packet(0, 1); });
	editor.playback.play();
	await flush();

	audio.currentTime = 10.99;
	frame(990);
	expect(editor.playback.getIsPlaying()).toBe(true);
	expect(stops).not.toHaveBeenCalled();

	audio.currentTime = 11;
	frame(10);
	expect(editor.playback.getIsPlaying()).toBe(false);
});

test("pausing releases queued audio and a parked decoder, and project close suspends playback again", async () => {
	const { editor } = setup();
	const { audio, starts, stops, disconnect } = fakeAudio();
	const finished = mock(() => {});
	stubFetch();
	stubDecoder(async function* () {
		try {
			yield packet(0, 0.1);
			yield packet(3, 0.1);
		} finally {
			finished();
		}
	});

	editor.playback.play();
	await flush();
	expect(starts).toHaveLength(1);
	expect(audio.state).toBe("running");
	editor.playback.pause();
	await flush();
	expect(stops).toHaveBeenCalledTimes(1);
	expect(disconnect).toHaveBeenCalledTimes(2);
	expect(finished).toHaveBeenCalledTimes(1);
	expect(audio.state).toBe("suspended");

	editor.playback.play();
	await flush();
	expect(audio.state).toBe("running");
	editor.project.closeProject();
	expect(editor.playback.getIsPlaying()).toBe(false);
	expect(audio.state).toBe("suspended");

	EditorCore.reset();
	expect(audio.close).toHaveBeenCalledTimes(1);
});

test("seeks share a pending sink and media changes cannot republish it", async () => {
	const { editor } = setup();
	fakeAudio();
	stubFetch();
	const { getTrack, track, decode } = stubDecoder(async function* () {});
	const old = deferred<InputAudioTrack>();
	const next = deferred<InputAudioTrack>();
	getTrack.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);

	editor.playback.play();
	await flush();
	editor.playback.seek({ time: t(3) });
	await flush();
	expect(getTrack).toHaveBeenCalledTimes(1);

	editor.media.setAssets({ assets: [] });
	await flush();
	expect(getTrack).toHaveBeenCalledTimes(2);
	next.resolve(track);
	await flush();
	old.resolve(track);
	await flush();
	expect(decode).toHaveBeenCalledTimes(1);

	editor.playback.seek({ time: t(5) });
	await flush();
	expect(getTrack).toHaveBeenCalledTimes(2);
	expect(decode.mock.calls.map((call) => call[0])).toEqual([3, 5]);
});

test("transcription closes its temporary context on success and on decode failure", async () => {
	const { audio } = fakeAudio();
	const audioBlob = new Blob(["audio"]);

	expect(await decodeAudioToFloat32({ audioBlob })).toEqual({
		samples: new Float32Array([0.5, 0.5]),
		sampleRate: 16_000,
	});
	expect(audio.close).toHaveBeenCalledTimes(1);

	audio.decodeAudioData.mockRejectedValueOnce(new Error("bad audio"));
	await expect(decodeAudioToFloat32({ audioBlob })).rejects.toThrow("bad audio");
	expect(audio.close).toHaveBeenCalledTimes(2);
});
