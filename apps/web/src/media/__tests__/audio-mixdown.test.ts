import { afterEach, expect, spyOn, test } from "bun:test";
import { AudioBufferSink, Input, InputAudioTrack, type WrappedAudioBuffer } from "mediabunny";
import { TestAudioBuffer } from "./audio-buffer";
import { mixTimelineAudio } from "@/media/audio-mixdown";
import { openAudioInput, decodeAudioWindow, sliceAudioWindow } from "@/media/audio-window";
import { createBlockMastering } from "@/media/audio-mastering";
import { createPitchReader } from "@/retime/audio-stretch";
import { t } from "@/timeline/__tests__/compound-fixtures";
import type { SceneTracks, UploadAudioElement } from "@/timeline";
import type { MediaAsset } from "@/media/types";

const sampleRate = 8_000;
const second = (samples: number) => samples / sampleRate;
const asset: MediaAsset = { id: "source", name: "Recording", type: "audio", file: new File(["audio"], "audio.wav") };
const cleanup: Array<() => void> = [];

function installBuffer() {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioBuffer");
	Object.defineProperty(globalThis, "AudioBuffer", { configurable: true, value: TestAudioBuffer });
	cleanup.push(() => {
		if (previous) Object.defineProperty(globalThis, "AudioBuffer", previous);
		else Reflect.deleteProperty(globalThis, "AudioBuffer");
	});
}

afterEach(() => {
	for (const restore of cleanup.splice(0).reverse()) restore();
});

function stubPackets(packets: (start: number, end: number) => AsyncGenerator<WrappedAudioBuffer, void, unknown>) {
	const track = Object.create(InputAudioTrack.prototype) as InputAudioTrack;
	Object.defineProperty(track, "sampleRate", { value: sampleRate });
	const getTrack = spyOn(Input.prototype, "getPrimaryAudioTrack").mockResolvedValue(track);
	const buffers = spyOn(AudioBufferSink.prototype, "buffers").mockImplementation(
		(start = 0, end = Infinity) => packets(start, end),
	);
	cleanup.push(() => getTrack.mockRestore(), () => buffers.mockRestore());
	return buffers;
}

function packet(timestamp: number, length: number, channel: number, numberOfChannels = 1): WrappedAudioBuffer {
	const buffer = new AudioBuffer({ numberOfChannels, length, sampleRate });
	buffer.getChannelData(channel).fill(0.5);
	return { buffer, timestamp, duration: buffer.duration };
}

function clip(id: string, start: number, trim: number, duration: number): UploadAudioElement {
	return {
		id, name: id, type: "audio", sourceType: "upload", mediaId: asset.id,
		startTime: t(start), trimStart: t(trim), duration: t(duration), trimEnd: t(0), params: { volume: 0 },
	};
}

function timeline(...elements: UploadAudioElement[]): SceneTracks {
	return {
		main: { id: "main", name: "Main", type: "video", muted: false, hidden: false, elements: [] },
		overlay: [],
		audio: [{ id: "audio", type: "audio", name: "Audio", muted: false, elements }],
	};
}

test("overlapping cuts share one late decode window and muted clips do not request samples", async () => {
	installBuffer();
	const buffers = stubPackets(async function* () { yield packet(7200, 4 * sampleRate, 0); });
	const muted = { ...clip("muted", 0, 7, 1), params: { muted: true } };
	const tracks = timeline(clip("a", 0, 7200, 2), clip("b", 2, 7201, 2), clip("c", 5, 7201, 1), muted);
	const blocks = await Array.fromAsync(mixTimelineAudio({ tracks, mediaAssets: [asset], duration: t(6), sampleRate }));
	expect(buffers).toHaveBeenCalledTimes(1);
	const [start, end] = buffers.mock.calls[0];
	expect(start).toBeCloseTo(7200, 2);
	expect(end).toBeCloseTo(7203, 2);
	expect(blocks.map((block) => block.length)).toEqual([5 * sampleRate, sampleRate]);
	expect(blocks[0].getChannelData(0)[0]).toBeCloseTo(0.5);
	expect(blocks[0].getChannelData(0)[4 * sampleRate]).toBe(0);
	expect(blocks[1].getChannelData(0)[0]).toBeCloseTo(0.5);
});

test("a two-hour, loud timeline starts with bounded PCM and does not open a live audio context", async () => {
	installBuffer();
	stubPackets(async function* (start) { yield packet(Math.round(start), sampleRate, 0); });
	const tracks = timeline(...Array.from({ length: 3 }, (_, index) => clip(String(index), 0, 0, 7200)));
	const stream = mixTimelineAudio({ tracks, mediaAssets: [asset], duration: t(7200), sampleRate });
	try {
		const first = await stream.next();
		expect(first.done).toBe(false);
		if (first.done) throw new Error("Expected audio");
		expect(first.value.length).toBe(5 * sampleRate);
		expect(first.value.getChannelData(0)[0]).toBeCloseTo(0.98);
	} finally {
		await stream.return();
	}
});

test("timestamps in a trim keep leading silence and packet gaps and discard negative preroll", async () => {
	installBuffer();
	stubPackets(async function* () {
		yield packet(-second(4), 3, 0);
		yield packet(second(2), 2, 0);
		yield packet(second(6), 2, 0);
	});
	const input = openAudioInput(asset.file);
	try {
		const window = await decodeAudioWindow({ input, start: second(1), end: second(8) });
		expect(window?.start).toBe(second(1));
		expect(Array.from(window!.buffer.getChannelData(0))).toEqual([0, 0.5, 0.5, 0, 0, 0.5, 0.5]);
	} finally {
		input.dispose();
	}
});

test("uploaded WAV audio uses the window decoder without Web Audio decoding", async () => {
	installBuffer();
	const wav = new ArrayBuffer(44 + 2 * sampleRate);
	const header = new DataView(wav);
	for (const [offset, fourCC] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) {
		for (let i = 0; i < fourCC.length; i++) header.setUint8(offset + i, fourCC.charCodeAt(i));
	}
	header.setUint32(4, wav.byteLength - 8, true);
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true);
	header.setUint16(22, 1, true);
	header.setUint32(24, sampleRate, true);
	header.setUint32(28, 2 * sampleRate, true);
	header.setUint16(32, 2, true);
	header.setUint16(34, 16, true);
	header.setUint32(40, wav.byteLength - 44, true);
	for (let i = sampleRate / 2; i < sampleRate; i++) header.setInt16(44 + 2 * i, 8192, true);

	const tracks = timeline(clip("wave", 0, 0.75, 0.01));
	const [block] = await Array.fromAsync(mixTimelineAudio({
		tracks, mediaAssets: [{ ...asset, file: new File([wav], "source.wav") }],
		duration: t(0.01), sampleRate,
	}));
	expect(block.length).toBe(80);
	expect(block.getChannelData(0)[0]).toBeCloseTo(0.25);
	expect(block.getChannelData(1)[79]).toBeCloseTo(0.25);
});

test("mixdown puts center-only 5.1 dialogue in both stereo channels and ignores LFE", async () => {
	installBuffer();
	stubPackets(async function* () {
		yield packet(0, 4, 2, 6);
		yield packet(second(4), 4, 3, 6);
	});
	const tracks = timeline(clip("dialogue", 0, 0, second(8)));
	const [block] = await Array.fromAsync(mixTimelineAudio({ tracks, mediaAssets: [asset], duration: t(second(8)), sampleRate }));
	for (let side = 0; side < 2; side++) {
		expect(block.getChannelData(side)[0]).toBeCloseTo(0.5 * Math.SQRT1_2);
		expect(block.getChannelData(side)[4]).toBe(0);
	}
});

test("96 kHz sources reject ultrasonic aliases across mix block boundaries", async () => {
	installBuffer();
	const nativeRate = 96_000;
	const outputRate = 44_100;
	const buffer = new AudioBuffer({ length: 11 * nativeRate, sampleRate: nativeRate });
	const source = buffer.getChannelData(0);
	for (let frame = 0; frame < source.length; frame++) {
		const time = frame / nativeRate;
		source[frame] = 0.25 * Math.sin(2 * Math.PI * 1_000 * time) + 0.4 * Math.sin(2 * Math.PI * 44_000 * time);
	}
	const tracks = timeline();
	tracks.audio[0].elements.push({
		...clip("library", 0, 0, 26), sourceType: "library", sourceUrl: "/library/high-rate.wav", buffer,
	});

	const blocks = mixTimelineAudio({ tracks, mediaAssets: [], duration: t(26), sampleRate: outputRate });
	try {
		for (let block = 0; block < 2; block++) {
			const result = await blocks.next();
			if (result.done) throw new Error("Expected an audio block");
			const samples = result.value.getChannelData(0);
			let peakError = 0;
			for (let frame = block ? 0 : 128; frame < samples.length; frame++) {
				const time = block * 5 + frame / outputRate;
				const expected = 0.25 * Math.sin(2 * Math.PI * 1_000 * time);
				peakError = Math.max(peakError, Math.abs(samples[frame] - expected));
			}
			expect(peakError).toBeLessThan(0.002);
		}
	} finally {
		await blocks.return();
	}
});

test("abort disposes an active reader without waiting for a pending packet", async () => {
	installBuffer();
	const requested = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<void>();
	stubPackets(async function* () {
		requested.resolve();
		await pending.promise;
	});
	const dispose = spyOn(Input.prototype, "dispose");
	cleanup.push(() => dispose.mockRestore());
	const controller = new AbortController();
	const tracks = timeline(clip("audio", 0, 10, 1), clip("next", 6, 20, 1));
	const stream = mixTimelineAudio({ tracks, mediaAssets: [asset], duration: t(9), sampleRate, signal: controller.signal });
	const first = stream.next();
	try {
		await requested.promise;
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });
		expect(dispose).toHaveBeenCalled();
	} finally {
		pending.resolve();
		await stream.return();
	}
});

test("mixing yields even with ready PCM, allowing a queued cancel to stop before export", async () => {
	installBuffer();
	const buffer = new AudioBuffer({ length: sampleRate * 5, sampleRate });
	const tracks = timeline();
	tracks.audio[0].elements.push({
		...clip("library", 0, 0, 5), sourceType: "library", sourceUrl: "/library/audio.wav", buffer,
	});
	const controller = new AbortController();
	const { port1, port2 } = new MessageChannel();
	port1.onmessage = () => controller.abort();
	port2.postMessage(null);
	const stream = mixTimelineAudio({ tracks, mediaAssets: [], duration: t(5), sampleRate, signal: controller.signal });
	try {
		await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		port1.close();
		port2.close();
		await stream.return();
	}
});

test("mastering carries its release between blocks", async () => {
	installBuffer();
	const limit = createBlockMastering(sampleRate);
	const first = new AudioBuffer({ numberOfChannels: 2, length: 1, sampleRate });
	const second = new AudioBuffer({ numberOfChannels: 2, length: 2, sampleRate });
	first.getChannelData(0)[0] = 2;
	second.getChannelData(1).fill(0.5);
	await limit.process(first);
	await limit.process(second);
	expect(first.getChannelData(0)[0]).toBeCloseTo(0.98);
	expect(second.getChannelData(1)[0]).toBeCloseTo(0.245, 2);
	expect(second.getChannelData(1)[1]).toBeGreaterThan(second.getChannelData(1)[0]);
});

test("pitch processing keeps the same samples across block boundaries and reads only short windows", async () => {
	installBuffer();
	const source = new AudioBuffer({ length: 2 * sampleRate, sampleRate, numberOfChannels: 6 });
	const center = source.getChannelData(2);
	for (let i = 0; i < center.length; i++) center[i] = 0.5 * Math.sin(i * 2 * Math.PI * 300 / sampleRate);
	const readWindow = async (start: number, end: number) => {
		expect(end - start).toBeLessThan(1.01);
		return sliceAudioWindow(source, start, end);
	};
	const options = { readWindow, sourceStart: 0, sourceEnd: 2, rate: 1.5, sampleRate };
	const split = createPitchReader(options);
	const before = await split(4999);
	const after = await split(3001);
	const whole = await createPitchReader(options)(8000);
	expect(Array.from(whole.getChannelData(0))).toEqual([
		...before.getChannelData(0), ...after.getChannelData(0),
	]);
	expect(whole.getChannelData(0).some((sample) => Math.abs(sample) > 0.1)).toBe(true);
	expect(whole.getChannelData(1)).toEqual(whole.getChannelData(0));
});
