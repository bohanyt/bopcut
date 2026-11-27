import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { AudioBufferSink, Input, InputAudioTrack, type WrappedAudioBuffer } from "mediabunny";
import { collectAudioClips, decodeAudioToFloat32 } from "@/media/audio";
import { mixTimelineAudio } from "@/media/audio-mixdown";
import { TestAudioBuffer } from "@/media/__tests__/audio-buffer";
import type { AudioElement, LibraryAudioElement, UploadAudioElement } from "@/timeline";
import { clipElementToRange } from "@/timeline/compound";
import { computeGroupResize } from "@/timeline/group-resize/compute-resize";
import { splitElementAt } from "@/timeline/split";
import { scene, t } from "@/timeline/__tests__/compound-fixtures";
import { subMediaTime, TICKS_PER_SECOND } from "@/wasm";

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
	return { timestamp, duration, buffer: new TestAudioBuffer({ length: Math.round(duration * 8000), sampleRate: 8000 }) };
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

function setup(clip: AudioElement | AudioElement[] = libraryClip()) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const clips = Array.isArray(clip) ? clip : [clip];
	const activeScene = scene("main", {
		overlay: [],
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
		audio: clips.map((element, index) => ({
			id: index ? `audio-${index}` : "audio", name: "Audio", type: "audio", muted: false, elements: [element],
		})),
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
	const uploads = clips.filter((element): element is UploadAudioElement => element.sourceType === "upload");
	if (uploads.length) {
		editor.media.setAssets({
			assets: uploads.map(({ mediaId, name }) => ({ id: mediaId, name, type: "audio", file: new File(["audio"], "audio.wav") })),
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

function fakeAudio({ withVisibility = false, sampleRate = 8_000 } = {}) {
	let raf: FrameRequestCallback | undefined;
	let wallTimeMs = 1_000;
	const starts: Array<{ when: number; offset?: number; duration?: number; rate: number }> = [];
	const buffers: AudioBuffer[] = [];
	const gains: Array<{ time: number; value: number }> = [];
	const disconnect = mock(() => {});
	const stops = mock(() => {});
	const setInterval = mock(() => 1);
	const clearInterval = mock(() => {});
	const visibility = Object.assign(new EventTarget(), { hidden: false });
	const wakes = new Map<EventTarget, number>();
	const audio = {
		currentTime: 10,
		sampleRate,
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
		createConstantSource: () => {
			const source = new EventTarget();
			return Object.assign(source, {
				offset: { value: 1 },
				connect() {},
				disconnect() { wakes.delete(source); },
				start() {},
				stop(deadline = audio.currentTime) { wakes.set(source, deadline); },
			});
		},
		createBufferSource: () => {
			const playbackRate = { value: 1 };
			return {
				buffer: null as AudioBuffer | null,
				playbackRate,
				connect() {},
				disconnect,
				stop: stops,
				addEventListener() {},
				start(when: number, offset?: number, duration?: number) {
					starts.push({ when, offset, duration, rate: playbackRate.value });
					if (this.buffer) buffers.push(this.buffer);
				},
			};
		},
	};

	stubGlobal("AudioBuffer", TestAudioBuffer);
	stubGlobal("window", { AudioContext: class { constructor() { return audio; } }, setInterval, clearInterval });
	if (withVisibility) stubGlobal("document", visibility);
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
	const setHidden = (hidden: boolean) => {
		visibility.hidden = hidden;
		visibility.dispatchEvent(new Event("visibilitychange"));
	};
	const advanceAudio = (time: number) => {
		audio.currentTime = time;
		for (const [source, deadline] of [...wakes]) {
			if (deadline <= time) source.dispatchEvent(new Event("ended"));
		}
	};
	const waitForStarts = async (count = 1) => {
		// Decoding and pitch processing can yield to another task before a source starts.
		for (let tick = 0; tick < 64 && starts.length < count; tick++) await flush();
		expect(starts.length).toBeGreaterThanOrEqual(count);
	};
	return { audio, starts, buffers, gains, frame, stops, disconnect, setInterval, wakes, setHidden, advanceAudio, waitForStarts };
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
	const { starts, setInterval, waitForStarts } = fakeAudio();
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
	await waitForStarts();
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
	const { audio, starts, frame, waitForStarts } = fakeAudio();
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
	frame(115);
	resumed.resolve();
	await flush();
	library.resolve(new Response("audio"));
	await waitForStarts();
	expect(decode.mock.calls[0][0]).toBeCloseTo(0.515, 6);
	expect(starts[0].offset).toBeCloseTo(0.015, 6);
	expect(starts[0].when).toBe(10);

	audio.currentTime = 70;
	frame(62_000);
	expect(editor.playback.getCurrentTime()).toBe(t(60.5));
});

test("a slow library sound holds back no ready audio and joins on the audio clock; a muted one is not fetched", async () => {
	const { editor } = setup([
		uploadedClip({ duration: t(4) }),
		libraryClip({ id: "late", duration: t(4) }),
		libraryClip({ id: "muted", sourceUrl: "https://example.test/muted.mp3", params: { volume: 0, muted: true } }),
	]);
	const { audio, starts, waitForStarts } = fakeAudio();
	const library = deferred<Response>();
	const fetch = stubFetch(library.promise);
	const { decode } = stubDecoder(async function* (start) { yield packet(start, 0.1); });

	editor.playback.play();
	await waitForStarts();
	expect(starts[0].when).toBe(10);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch).toHaveBeenCalledWith("https://example.test/sound.mp3", expect.anything());

	// The sound arrives a second later on the audio clock and starts one second in.
	audio.currentTime = 11;
	library.resolve(new Response("audio"));
	await waitForStarts(2);
	expect(decode.mock.calls[1][0]).toBeCloseTo(1, 6);
	expect(starts[1].when).toBe(11);
});

test("streaming clips cut spanning packets at both ends and place fade corners on the timeline", async () => {
	const { editor } = setup(uploadedClip({
		startTime: t(0.5),
		duration: t(0.4),
		trimStart: t(1),
		params: { volume: 0, fadeIn: 0.04, fadeOut: 0.09 },
	}));
	const { starts, gains, waitForStarts } = fakeAudio();
	const { decode } = stubDecoder(async function* () {
		yield packet(0.9, 0.2);
		yield packet(1.3, 0.2);
	});

	editor.playback.play();
	await waitForStarts(2);

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
	const { audio, starts, waitForStarts } = fakeAudio();
	stubDecoder(async function* () {
		audio.currentTime = 10.15;
		yield packet(0, 0.2);
		yield packet(0.2, 0.4);
	});

	editor.playback.play();
	await waitForStarts();

	expect(starts).toHaveLength(1);
	expect(starts[0].rate).toBe(2);
	expect(starts[0].when).toBe(10.15);
	expect(starts[0].offset).toBeCloseTo(0.1, 6);
	expect(starts[0].duration).toBeCloseTo(0.3, 6);
});

test("pitch-preserved preview prepares short windows at a late trim and parks ahead of playback", async () => {
	const { editor } = setup(uploadedClip({
		duration: t(20), trimStart: t(7200), retime: { rate: 2, maintainPitch: true },
	}));
	const { starts, waitForStarts } = fakeAudio();
	const { decode, track } = stubDecoder(async function* (start) {
		yield packet(Math.floor(start), 2);
	});
	Object.defineProperty(track, "sampleRate", { value: 8000 });

	editor.playback.play();
	await waitForStarts(2);

	expect(starts.map(({ when, rate }) => [when, rate])).toEqual([[10, 1], [11, 1]]);
	expect(decode.mock.calls[0][0]).toBeCloseTo(7200, 2);
	expect(decode.mock.calls.every(([start = 0, end = Infinity]) => end - start < 1.01)).toBe(true);
	expect(decode.mock.calls.at(-1)?.[1]).toBeLessThan(7207);

	editor.playback.pause();
	await flush();
	expect(starts).toHaveLength(2);
});

test("pitch-preserved preview seeks keep in-trim taps before the cursor", async () => {
	const sampleRate = 44_100;
	const nativeRate = 48_000;
	const rate = 1.5;
	const trim = 0.25;
	const seek = 0.5;
	const { editor } = setup(uploadedClip({
		duration: t(1), trimStart: t(trim), retime: { rate, maintainPitch: true },
	}));
	const { buffers, waitForStarts } = fakeAudio({ sampleRate });
	const buffer = new TestAudioBuffer({ length: 2 * nativeRate, sampleRate: nativeRate });
	// Only the last native sample before the cursor carries this signal.
	const cursor = (trim + seek * rate) * nativeRate;
	buffer.getChannelData(0)[cursor - 1] = 0.5;
	stubDecoder(async function* () { yield { buffer, timestamp: 0, duration: buffer.duration }; });

	editor.playback.seek({ time: t(seek) });
	editor.playback.play();
	await waitForStarts();

	expect(buffers).toHaveLength(1);
	expect(buffers[0].length).toBe(sampleRate / 2);
	expect(Math.max(...buffers[0].getChannelData(0).subarray(0, 16).map(Math.abs))).toBeGreaterThan(0.0001);
});

const roundedCutCases = [
	{ nativeRate: 48_000, sampleRate: 44_100 },
	{ nativeRate: 44_100, sampleRate: 48_000 },
].flatMap((rates) => (["direct", "compound", "split", "frame split"] as const).map((edit) => ({ ...rates, edit })));
test.each(roundedCutCases)(
	"preview and export exclude the first native sample at a rounded cut ($nativeRate to $sampleRate Hz, $edit)", async ({
	nativeRate, sampleRate, edit,
}) => {
	const rate = edit === "frame split" ? 1.15 : 0.85;
	const end = edit === "frame split" ? 0.53375 : edit === "split" ? 0.4 : 0.1;
	const original = uploadedClip({
		duration: t(end / rate), sourceDuration: t(1), trimEnd: t(1 - end), retime: { rate, maintainPitch: true },
	});
	let element = original;
	if (edit === "compound") {
		const clipped = clipElementToRange({ element, rangeStart: t(0.000025), rangeEnd: element.duration });
		if (!clipped) throw new Error("Expected a visible clip");
		element = clipped;
	}
	if (edit === "split" || edit === "frame split") {
		const splitCount = edit === "frame split" ? 5 : 3;
		const step = edit === "frame split" ? 1001 / 30_000 : 0.000025;
		for (let split = 1; split <= splitCount; split++) {
			const parts = splitElementAt({ element, splitTime: t(split * step), rightId: `right-${split}` });
			if (parts?.right.type !== "audio" || parts.right.sourceType !== "upload") throw new Error("Expected an audio split");
			element = parts.right;
		}
	}
	const { duration } = element;
	const { editor, tracks } = setup({ ...element, startTime: t(0) });
	const { buffers, waitForStarts } = fakeAudio({ sampleRate });
	const buffer = new TestAudioBuffer({ length: nativeRate, sampleRate: nativeRate });
	buffer.getChannelData(0)[Math.ceil(nativeRate * end)] = 1;
	stubDecoder(async function* () { yield { buffer, timestamp: 0, duration: buffer.duration }; });

	editor.playback.play();
	await waitForStarts();
	editor.playback.pause();

	expect(buffers).toHaveLength(1);
	expect(buffers[0].getChannelData(0).every((value) => value === 0)).toBe(true);
	const blocks: AudioBuffer[] = [];
	for await (const block of mixTimelineAudio({ tracks, mediaAssets: editor.media.getAssets(), duration, sampleRate })) {
		blocks.push(block);
	}
	expect(blocks).toHaveLength(1);
	expect(blocks[0].length).toBe(buffers[0].length);
	expect(blocks[0].getChannelData(0)).toEqual(buffers[0].getChannelData(0));
	expect(blocks[0].getChannelData(1)).toEqual(buffers[0].getChannelData(1));
});

test("right extension applies its delta to the stored cut after repeated 1.15x frame splits", () => {
	const fps = { numerator: 30_000, denominator: 1001 };
	const { updates: [{ patch }] } = computeGroupResize({
		members: [{
			elementId: "audio", trackId: "audio", startTime: t(5 * 1001 / 30_000),
			duration: subMediaTime({ a: t(0.53375 / 1.15), b: t(5 * 1001 / 30_000) }),
			trimStart: t(23_025 / TICKS_PER_SECOND), trimEnd: t(1 - 0.53375), sourceDuration: t(1),
			retime: { rate: 1.15, maintainPitch: true }, leftNeighborBound: null, rightNeighborBound: null,
		}],
		side: "right", deltaTime: t(1001 / 30_000), fps,
	});
	expect(patch.trimEnd).toBe(t(51_345 / TICKS_PER_SECOND));
});

test("a legacy retimed clip with stale trim metadata keeps its visible source window", async () => {
	const nativeRate = 48_000;
	const sampleRate = 44_100;
	const { editor } = setup(uploadedClip({
		duration: t(0.25), trimStart: t(0.25), sourceDuration: t(1), retime: { rate: 2, maintainPitch: true },
	}));
	const { buffers, waitForStarts } = fakeAudio({ sampleRate });
	const buffer = new TestAudioBuffer({ length: nativeRate, sampleRate: nativeRate });
	buffer.getChannelData(0).fill(0.5, nativeRate * 0.75);
	stubDecoder(async function* () { yield { buffer, timestamp: 0, duration: buffer.duration }; });

	editor.playback.play();
	await waitForStarts();

	expect(buffers).toHaveLength(1);
	expect(buffers[0].getChannelData(0).every((value) => value === 0)).toBe(true);
});

test.each([0, 0.05])("a legacy duration-only edit retains its playable source at 2x after a %d s leading split", async (splitTime) => {
	const sampleRate = 48_000;
	let element = uploadedClip({
		duration: t(0.25), sourceDuration: t(1), trimEnd: t(0.75), retime: { rate: 2, maintainPitch: true },
	});
	if (splitTime > 0) {
		const parts = splitElementAt({ element, splitTime: t(splitTime), rightId: "legacy-right" });
		if (parts?.right.type !== "audio" || parts.right.sourceType !== "upload") throw new Error("Expected an audio split");
		element = parts.right;
	}
	const { editor } = setup({ ...element, startTime: t(0) });
	const { buffers, waitForStarts } = fakeAudio({ sampleRate });
	const buffer = new TestAudioBuffer({ length: sampleRate, sampleRate });
	buffer.getChannelData(0).fill(0.5, sampleRate * 0.3, sampleRate * 0.5);
	stubDecoder(async function* () { yield { buffer, timestamp: 0, duration: buffer.duration }; });

	editor.playback.play();
	await waitForStarts();

	expect(buffers).toHaveLength(1);
	expect(buffers[0].getChannelData(0).some((value) => value > 0.1)).toBe(true);
});

test("a right extension of a legacy 2x clip keeps its audible tail", async () => {
	const sampleRate = 44_100;
	const nativeRate = 48_000;
	const element = uploadedClip({
		duration: t(0.25), sourceDuration: t(1), trimEnd: t(0.75), retime: { rate: 2, maintainPitch: true },
	});
	const { updates: [{ patch }] } = computeGroupResize({
		members: [{ ...element, elementId: element.id, trackId: "audio", leftNeighborBound: null, rightNeighborBound: null }],
		side: "right", deltaTime: t(0.1), fps: { numerator: 30, denominator: 1 },
	});
	const duration = t(0.35);
	expect(patch.duration).toBe(duration);
	const { editor, tracks } = setup({ ...element, ...patch });
	const { buffers, waitForStarts } = fakeAudio({ sampleRate });
	const buffer = new TestAudioBuffer({ length: nativeRate, sampleRate: nativeRate });
	buffer.getChannelData(0).fill(0.5, nativeRate * 0.48, nativeRate * 0.65);
	stubDecoder(async function* () { yield { buffer, timestamp: 0, duration: buffer.duration }; });

	editor.playback.play();
	await waitForStarts();
	editor.playback.pause();
	expect(buffers).toHaveLength(1);
	expect(buffers[0].getChannelData(0).some((value) => value > 0.4)).toBe(true);
	const blocks: AudioBuffer[] = [];
	for await (const block of mixTimelineAudio({ tracks, mediaAssets: editor.media.getAssets(), duration, sampleRate })) {
		blocks.push(block);
	}
	expect(blocks).toHaveLength(1);
	expect(blocks[0].getChannelData(0)).toEqual(buffers[0].getChannelData(0));
});

const pitchCases = [44_100, 48_000].flatMap((sampleRate) => [
	...[1, 2].flatMap((channels) => [0.5, 1.5, 2].map((rate) => ({ sampleRate, channels, rate, frequency: 300 }))),
	{ sampleRate, channels: 1, rate: 4, frequency: 45 },
]);

const timingCases = [44_100, 48_000].flatMap((sampleRate) => [
	{ sampleRate, rate: 0.5, duration: 1, fixture: "tail" },
	{ sampleRate, rate: 0.5, duration: 0.01, fixture: "tail" },
	{ sampleRate, rate: 0.5, duration: 1, fixture: "midpoint" },
	{ sampleRate, rate: 2, duration: 0.1, fixture: "midpoint" },
	{ sampleRate, rate: 4, duration: 1, fixture: "midpoint" },
	{ sampleRate, rate: 4, duration: 0.1, fixture: "stereo attack" },
	{ sampleRate, rate: 4, duration: 0.1, fixture: "overlapping attacks" },
	{ sampleRate, rate: 4, duration: 0.1, fixture: "overlapping attacks after seek" },
]);
test.each(timingCases)("pitch timing $fixture at $sampleRate Hz, $rate x and $duration s", async ({ sampleRate, rate, duration, fixture }) => {
	const nativeRate = 48_000;
	const overlap = fixture.startsWith("overlapping attacks");
	const seek = fixture.endsWith("after seek") ? 0.05 : 0;
	const { editor, tracks } = setup(uploadedClip({ duration: t(duration), retime: { rate, maintainPitch: true } }));
	const { buffers, waitForStarts } = fakeAudio({ sampleRate });
	const buffer = new TestAudioBuffer({ length: Math.round(nativeRate * duration * rate), sampleRate: nativeRate, numberOfChannels: 2 });
	if (fixture === "tail") {
		for (let channel = 0; channel < 2; channel++) buffer.getChannelData(channel).fill(0.4);
	} else if (fixture === "midpoint") {
		buffer.getChannelData(0)[Math.floor(buffer.length / 2)] = 0.9;
	} else {
		buffer.getChannelData(0)[100] = 0.9;
		buffer.getChannelData(1)[5] = 0.8;
		if (overlap) {
			buffer.getChannelData(0)[5] = 0.8;
			buffer.getChannelData(1)[buffer.length - 100] = 0.9;
			buffer.getChannelData(1)[buffer.length - 5] = 0.8;
		}
	}
	stubDecoder(async function* () { yield { buffer, timestamp: 0, duration: buffer.duration }; });
	if (seek) editor.playback.seek({ time: t(seek) });
	editor.playback.play();
	await waitForStarts();
	editor.playback.pause();
	const [mixed] = await Array.fromAsync(mixTimelineAudio({ tracks, mediaAssets: editor.media.getAssets(), rangeStart: t(seek), duration: t(duration), sampleRate }));
	expect(mixed.length).toBe(Math.round((duration - seek) * sampleRate));
	if (overlap) {
		const expected = [[5, 100], [5, buffer.length - 100, buffer.length - 5]];
		for (const output of [buffers[0], mixed]) {
			for (const [channel, frames] of expected.entries()) {
				const expectedPeaks = frames.map((frame) => (frame / nativeRate / rate - seek) * sampleRate).filter((frame) => frame >= 0);
				const samples = output.getChannelData(channel);
				const attacks = Array.from(samples.entries()).filter(([i, value]) =>
					value > 0.45 && value > (samples[i - 1] ?? 0) && value > (samples[i + 1] ?? 0),
				).map(([i]) => i);
				expect(attacks).toHaveLength(expectedPeaks.length);
				for (const [i, frame] of expectedPeaks.entries()) {
					expect(Math.abs(attacks[i] - frame)).toBeLessThanOrEqual(1);
				}
			}
		}
		return;
	}
	const measured = [buffers[0], mixed].map((output) => [0, 1].map((channel) => {
		const samples = output.getChannelData(channel);
		let peak = 0;
		let peakFrame = -1;
		let lastAudible = -1;
		for (let frame = 0; frame < samples.length; frame++) {
			const level = Math.abs(samples[frame]);
			if (level > 0.1) lastAudible = frame;
			if (level > peak) { peak = level; peakFrame = frame; }
		}
		return { peak, peakMs: peakFrame === -1 ? null : peakFrame / sampleRate * 1000, tailGapMs: (samples.length - lastAudible - 1) / sampleRate * 1000 };
	}));
	for (const output of measured) {
		if (fixture === "tail") {
			for (const channel of output) expect(channel.tailGapMs).toBe(0);
		} else {
			const expected = fixture === "midpoint" ? [duration / 2 * 1000] : [100, 5].map((frame) => frame / nativeRate / rate * 1000);
			const minimumPeaks = fixture === "midpoint" ? [0.7] : [0.7, 0.5];
			for (const [channel, milliseconds] of expected.entries()) {
				expect(output[channel].peak).toBeGreaterThan(minimumPeaks[channel]);
				expect(Math.abs((output[channel].peakMs ?? Infinity) - milliseconds)).toBeLessThanOrEqual(1000 / sampleRate);
			}
		}
	}
});

test.each(pitchCases)("retimed preview and export match at $sampleRate Hz, $channels channel(s), $rate x, $frequency Hz tone", async ({
	sampleRate, channels, rate, frequency,
}) => {
	const nativeRate = sampleRate === 44_100 ? 48_000 : 44_100;
	const duration = 1.2;
	const { editor, tracks } = setup(uploadedClip({
		duration: t(duration), trimStart: t(0.25001), retime: { rate, maintainPitch: true },
	}));
	const { buffers, starts, waitForStarts } = fakeAudio({ sampleRate });
	const buffer = new TestAudioBuffer({ length: Math.ceil(0.3 + duration * rate) * nativeRate, sampleRate: nativeRate, numberOfChannels: channels });
	for (let channel = 0; channel < channels; channel++) {
		const samples = buffer.getChannelData(channel);
		for (let frame = 0; frame < samples.length; frame++) {
			samples[frame] = 0.5 * Math.sin(2 * Math.PI * (frequency + channel * 100) * frame / nativeRate);
		}
	}
	stubDecoder(async function* () { yield { buffer, timestamp: 0, duration: buffer.duration }; });

	editor.playback.play();
	await waitForStarts(2);
	expect(buffers.map((block) => block.length)).toEqual([sampleRate, sampleRate / 5]);
	expect(starts[0]).toMatchObject({ offset: 0, duration: 1, rate: 1 });
	expect(starts[1]).toMatchObject({ offset: 0, rate: 1 });
	expect(starts[1].duration).toBeCloseTo(0.2, 10);
	editor.playback.pause();

	const blocks: AudioBuffer[] = [];
	for await (const block of mixTimelineAudio({ tracks, mediaAssets: editor.media.getAssets(), duration: t(duration), sampleRate })) {
		blocks.push(block);
	}
	expect(blocks).toHaveLength(1);
	expect(blocks[0].length).toBe(duration * sampleRate);
	for (let channel = 0; channel < 2; channel++) {
		const samples = blocks[0].getChannelData(channel);
		expect(buffers[0].getChannelData(channel)).toEqual(samples.subarray(0, sampleRate));
		expect(buffers[1].getChannelData(channel)).toEqual(samples.subarray(sampleRate));
		let crossings = 0;
		for (let frame = sampleRate / 10 + 1; frame <= sampleRate * 0.4; frame++) {
			if (samples[frame - 1] <= 0 && samples[frame] > 0) crossings++;
		}
		const expectedFrequency = frequency + (channels === 2 && channel === 1 ? 100 : 0);
		expect(Math.abs(crossings - expectedFrequency * 0.3)).toBeLessThanOrEqual(2);
	}
});

test("rounding the preview frame to the end does not stop the last audio samples early", async () => {
	const { editor } = setup(uploadedClip({ duration: t(1) }));
	const { audio, frame, stops, waitForStarts } = fakeAudio();
	stubDecoder(async function* () { yield packet(0, 1); });
	editor.playback.play();
	await waitForStarts();

	audio.currentTime = 10.99;
	frame(990);
	expect(editor.playback.getIsPlaying()).toBe(true);
	expect(stops).not.toHaveBeenCalled();

	audio.currentTime = 11;
	frame(10);
	expect(editor.playback.getIsPlaying()).toBe(false);
});

test("background audio starts future clips, feeds parked decoders and stops at timeline end without frames", async () => {
	const { starts, audio, wakes, setHidden, advanceAudio, waitForStarts } = fakeAudio({ withVisibility: true });
	const { editor } = setup(uploadedClip({ startTime: t(4), duration: t(5) }));
	const { decode } = stubDecoder(async function* () {
		yield packet(0, 0.1);
		yield packet(3, 0.1);
	});

	editor.playback.play();
	await flush();
	expect(decode).not.toHaveBeenCalled();

	setHidden(true);
	expect([...wakes.values()]).toEqual([12]);
	advanceAudio(12);
	await flush();
	expect(decode).toHaveBeenCalledTimes(1);
	expect(starts).toHaveLength(0);

	advanceAudio(13);
	await waitForStarts();
	expect(starts.map((start) => start.when)).toEqual([14]);

	advanceAudio(16);
	await waitForStarts(2);
	expect(starts.map((start) => start.when)).toEqual([14, 17]);

	advanceAudio(19);
	expect(editor.playback.getIsPlaying()).toBe(false);
	expect(editor.playback.getCurrentTime()).toBe(t(9));
	expect(audio.state).toBe("suspended");
	expect(wakes.size).toBe(0);
});

test("background wake is cancelled when the tab returns or playback stops", async () => {
	const { starts, wakes, setHidden, advanceAudio } = fakeAudio({ withVisibility: true });
	const { editor } = setup(uploadedClip({ startTime: t(4), duration: t(5) }));
	const { decode } = stubDecoder(async function* () { yield packet(0, 0.1); });

	editor.playback.play();
	await flush();
	setHidden(true);
	expect(wakes.size).toBe(1);
	setHidden(false);
	expect(wakes.size).toBe(0);
	setHidden(true);
	expect(wakes.size).toBe(1);
	editor.playback.pause();
	expect(wakes.size).toBe(0);

	advanceAudio(15);
	await flush();
	expect(decode).not.toHaveBeenCalled();
	expect(starts).toHaveLength(0);
});

test("pausing releases queued audio and a parked decoder, and project close suspends playback again", async () => {
	const { editor } = setup();
	const { audio, starts, stops, disconnect, waitForStarts } = fakeAudio();
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
	await waitForStarts();
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
