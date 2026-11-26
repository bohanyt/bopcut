import { expect, mock, spyOn, test } from "bun:test";
import {
	AudioSample, AudioSampleSink, BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource,
	Input, InputAudioTrack, InputVideoTrack, MP4, Mp4OutputFormat, Output, StreamSource, VideoSample, VideoSampleSink,
} from "mediabunny";
import { toast } from "sonner";
import { getRaisedProjectFpsForImportedMedia } from "@/fps/utils";
import { storageService } from "@/services/storage/service";
import { processMediaFile } from "./processing";
import { releaseMediaAssetUrls } from "./url-release";
import { withFirstVideoFrame } from "./video-probe";

const allowStorage = () => spyOn(storageService, "canStoreFile")
	.mockResolvedValue({ canStore: true, availableBytes: null, reason: "estimate-unavailable" });

test.each([
	["video/webm", undefined, "webm", "application/octet-stream", true],
	["video/mp4", undefined, "mp4", "image/gif", false],
	["video/mp4", "20", "mp4", "image/gif", true],
] as const)("imports GIF conversion as %s with source cadence %p", async (mime, cadence, extension, originalMime, variableDelay) => {
	const file = new File(["GIF"], "overlay.GIF", { type: originalMime });
	const track: InputVideoTrack = Object.create(InputVideoTrack.prototype, {
		displayWidth: { value: 16 },
		displayHeight: { value: 16 },
		canDecode: { value: async () => true },
		getFirstTimestamp: { value: async () => 0 },
		computeDuration: { value: async () => 1 },
		computePacketStats: { value: async () => ({ averagePacketRate: cadence ? 100 : 12 }) },
	});
	const headers = new Headers({ "Content-Type": mime });
	if (cadence) headers.set("X-Bopencut-GIF-FPS", cadence);
	if (variableDelay) headers.set("X-Bopencut-GIF-Variable-Delay", "1");
	const stubs = [
		allowStorage(),
		spyOn(globalThis, "fetch").mockResolvedValue(new Response("converted", { headers })),
		spyOn(Input.prototype, "getPrimaryVideoTrack").mockResolvedValue(track),
		spyOn(Input.prototype, "getPrimaryAudioTrack").mockResolvedValue(null),
		spyOn(EncodedPacketSink.prototype, "getPacket").mockResolvedValue(new EncodedPacket(Uint8Array.of(1), "key", 0, 1)),
		spyOn(EncodedPacketSink.prototype, "getNextPacket").mockResolvedValue(null),
		spyOn(VideoSampleSink.prototype, "samples").mockImplementation(async function* () {
			yield Object.create(VideoSample.prototype, { close: { value: () => {} } });
		}),
	];
	try {
		const imported = await processMediaFile({ file, signal: new AbortController().signal });
		try {
			expect(imported).toMatchObject({ name: `overlay.${extension}`, type: "video", duration: 1, hasAudio: false, fps: cadence ? Number(cadence) : 12 });
			expect(imported?.file.type).toBe(mime);
			expect(imported?.hasVariableGifDelay).toBe(variableDelay ? true : undefined);
			expect(await imported?.file.text()).toBe("converted");
			if (imported) {
				expect(getRaisedProjectFpsForImportedMedia({
					currentFps: { numerator: 30, denominator: 1 },
					importedAssets: [imported],
				})).toBeNull();
			}
		} finally {
			if (imported) releaseMediaAssetUrls(imported);
		}
	} finally {
		for (const stub of stubs) stub.mockRestore();
	}
});

test.each(["usable", "unsupported", "corrupt", "absent", "hdr"] as const)("video import with %s audio retains the original and measured FPS without a thumbnail", async (kind) => {
	// "hdr": usable audio in an HLG video, which gets a notice that it is shown as SDR.
	const audio = kind === "hdr" ? "usable" : kind;
	const file = new File(["video"], "footage.mkv", { type: "application/octet-stream" });
	const fps = 30_000 / 1_001;
	const videoTrack: InputVideoTrack = Object.create(InputVideoTrack.prototype, {
		displayWidth: { value: 16 },
		displayHeight: { value: 9 },
		canDecode: { value: async () => true },
		codec: { value: "avc" },
		getFirstTimestamp: { value: async () => 2 },
		computeDuration: { value: async () => 3 },
		computePacketStats: { value: async () => ({ averagePacketRate: fps }) },
		getColorSpace: { value: async () => ({ transfer: kind === "hdr" ? "hlg" : "bt709" }) },
	});
	const audioTrack: InputAudioTrack = Object.create(InputAudioTrack.prototype, {
		canDecode: { value: async () => audio !== "unsupported" },
		getFirstTimestamp: { value: async () => 0 },
		computeDuration: { value: async () => 4 },
	});
	const closeFrame = mock(() => {});
	const frame: VideoSample = Object.create(VideoSample.prototype, { close: { value: closeFrame } });
	const closeAudio = mock(() => {});
	const sample: AudioSample = Object.create(AudioSample.prototype, { close: { value: closeAudio } });
	const warn = spyOn(toast, "warning");
	const videoRead = spyOn(VideoSampleSink.prototype, "samples").mockImplementation(async function* () { yield frame; });
	const returnAudio = mock(() => {});
	const audioRead = spyOn(AudioSampleSink.prototype, "samples").mockImplementation(async function* () {
		try {
			if (audio === "corrupt") throw new Error("Invalid audio packet");
			yield sample;
		} finally {
			returnAudio();
		}
	});
	const stubs = [
		// A timestamp lookup can return no audio for a valid codec's priming packet.
		spyOn(AudioSampleSink.prototype, "getSample").mockResolvedValue(null),
		spyOn(Input.prototype, "getPrimaryVideoTrack").mockResolvedValue(videoTrack),
		spyOn(Input.prototype, "getPrimaryAudioTrack").mockResolvedValue(audio === "absent" ? null : audioTrack),
		spyOn(Input.prototype, "computeDuration").mockResolvedValue(4),
		spyOn(EncodedPacketSink.prototype, "getPacket").mockResolvedValue(new EncodedPacket(Uint8Array.of(1), "key", 2, 1)),
		spyOn(EncodedPacketSink.prototype, "getNextPacket").mockResolvedValue(null),
		allowStorage(), warn, videoRead, audioRead,
	];
	try {
		const imported = await processMediaFile({ file, signal: new AbortController().signal });
		try {
			expect(imported).toMatchObject({ type: "video", duration: audio === "usable" ? 4 : 3, fps, hasAudio: audio === "usable", thumbnailUrl: undefined });
			expect(imported?.file).toBe(file);
			expect(videoRead).toHaveBeenCalledWith(2);
			expect(closeFrame).toHaveBeenCalledTimes(1);
			expect(closeAudio).toHaveBeenCalledTimes(audio === "usable" ? 1 : 0);
			expect(returnAudio).toHaveBeenCalledTimes(audio === "usable" || audio === "corrupt" ? 1 : 0);
			expect(warn).toHaveBeenCalledTimes(audio === "unsupported" || audio === "corrupt" || kind === "hdr" ? 1 : 0);
			if (kind === "hdr") expect(warn.mock.calls[0][0]).toContain("HDR");
		} finally {
			if (imported) releaseMediaAssetUrls(imported);
		}
	} finally {
		for (const stub of stubs) stub.mockRestore();
	}
});

test.each(["application/octet-stream", "video/mp4"])("corrupt video with type %s is never given an asset URL", async (type) => {
	const allow = allowStorage();
	const create = spyOn(URL, "createObjectURL");
	const dispose = spyOn(Input.prototype, "dispose");
	try {
		const signal = new AbortController().signal;
		const file = new File(["not video"], "footage.mp4", { type });
		const asset = await processMediaFile({ file, signal });
		try {
			expect(asset).toBeNull();
			expect(create).not.toHaveBeenCalled();
			expect(dispose).toHaveBeenCalledTimes(1);
		} finally {
			if (asset) releaseMediaAssetUrls(asset);
		}
	} finally {
		dispose.mockRestore();
		create.mockRestore();
		allow.mockRestore();
	}
});

async function videoFile(timestamps = [0, 1], padLastPacket = false) {
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
	const track = new EncodedVideoPacketSource("avc");
	output.addVideoTrack(track);
	const data = Uint8Array.from(atob("AAAAAWdkAAqs2V7ARAAAAwAEAAADAMg8SJZYAAAAAWjr48siwAAAAWWIhAAr//72c3wKa22xgQ=="), (byte) => byte.charCodeAt(0));
	await output.start();
	for (const [index, timestamp] of timestamps.entries()) {
		let packet = data;
		if (padLastPacket && index === timestamps.length - 1) {
			// A filler NAL unit puts the final packet outside the demuxer's metadata reads.
			packet = new Uint8Array(512 * 1024).fill(0xff);
			packet.set(data);
			packet.set([0, 0, 1, 0x0c], data.length);
			packet[packet.length - 1] = 0x80;
		}
		await track.add(new EncodedPacket(packet, index === 0 ? "key" : "delta", timestamp, 1), {
			decoderConfig: { codec: "avc1.64000a", codedWidth: 16, codedHeight: 16 },
		});
	}
	await output.finalize();
	if (!output.target.buffer) throw new Error("Missing video test data");
	return output.target.buffer;
}

test.each([false, true])("a truncated MP4 with an intact sample table is rejected (reordered: %p)", async (reordered) => {
	const video = await videoFile(reordered ? [0, 2, 1] : [0, 1]);
	const file = new File([video.slice(0, -8)], "truncated.mp4", { type: "video/mp4" });
	const allow = allowStorage();
	const canDecode = spyOn(InputVideoTrack.prototype, "canDecode").mockResolvedValue(true);
	const decode = spyOn(VideoSampleSink.prototype, "samples").mockImplementation(async function* () {
		yield Object.create(VideoSample.prototype, { close: { value: () => {} } });
	});
	const input = new Input({ source: new BlobSource(file), formats: [MP4] });
	try {
		expect(await input.computeDuration()).toBe(reordered ? 3 : 2);
		if (reordered) {
			const track = await input.getPrimaryVideoTrack();
			if (!track) throw new Error("Missing video test track");
			const sink = new EncodedPacketSink(track);
			const lastPresented = await sink.getPacket(Infinity);
			if (!lastPresented) throw new Error("Missing last presentation packet");
			expect(lastPresented.timestamp).toBe(2);
			await expect(sink.getNextPacket(lastPresented)).rejects.toThrow();
		}
		const asset = await processMediaFile({ file, signal: new AbortController().signal });
		if (asset) releaseMediaAssetUrls(asset);
		expect(asset).toBeNull();
		expect(decode).not.toHaveBeenCalled();
	} finally {
		input.dispose();
		decode.mockRestore();
		canDecode.mockRestore();
		allow.mockRestore();
	}
});

test.each(["unsupported", "empty decode"] as const)("valid container with %s picture is rejected", async (failure) => {
	const buffer = await videoFile();
	if (failure === "unsupported") {
		const bytes = new Uint8Array(buffer);
		// Change the sample entry to a ProRes codec ID that has no public VideoCodec.
		const entry = bytes.findIndex((byte, i) => byte === 0x61 && bytes[i + 1] === 0x76 &&
			bytes[i + 2] === 0x63 && bytes[i + 3] === 0x31 && bytes[i + 4] === 0);
		if (entry < 0) throw new Error("Missing AVC sample entry");
		bytes.set(new TextEncoder().encode("apch"), entry);
	}
	const file = new File([buffer], "footage.mp4", { type: "video/mp4" });
	const stubs = [
		allowStorage(),
		spyOn(InputVideoTrack.prototype, "canDecode").mockResolvedValue(failure !== "unsupported"),
		spyOn(VideoSampleSink.prototype, "samples").mockImplementation(async function* () {}),
	];
	const error = spyOn(toast, "error");
	try {
		const asset = await processMediaFile({ file, signal: new AbortController().signal });
		if (asset) releaseMediaAssetUrls(asset);
		expect(asset).toBeNull();
		expect(error).toHaveBeenCalledWith(`Couldn't process ${file.name}`, {
			description: expect.stringContaining(failure === "unsupported" ? "APCH" : "No video frames"),
		});
	} finally {
		error.mockRestore();
		for (const stub of stubs) stub.mockRestore();
	}
});

test("an audio-only MP4 cannot be imported as video", async () => {
	const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	const audio = new EncodedAudioPacketSource("aac");
	output.addAudioTrack(audio);
	await output.start();
	await audio.add(new EncodedPacket(Uint8Array.of(1, 2), "key", 0, 1), {
		decoderConfig: { codec: "mp4a.40.2", sampleRate: 44_100, numberOfChannels: 2, description: Uint8Array.of(0x12, 0x10) },
	});
	await output.finalize();
	if (!output.target.buffer) throw new Error("Missing audio test data");
	const file = new File([output.target.buffer], "audio-only.mp4", { type: "video/mp4" });
	const allow = allowStorage();
	try {
		const asset = await processMediaFile({ file, signal: new AbortController().signal });
		if (asset) releaseMediaAssetUrls(asset);
		expect(asset).toBeNull();
	} finally {
		allow.mockRestore();
	}
});

test("cancelling the video probe disposes the input and closes a late frame", async () => {
	const file = new File([await videoFile()], "footage.mp4", { type: "video/mp4" });
	const pending = Promise.withResolvers<IteratorResult<VideoSample, void>>();
	const reading = Promise.withResolvers<void>();
	const close = mock(() => {});
	const closeIterator = mock(async (): Promise<IteratorResult<VideoSample, void>> => ({ done: true, value: undefined }));
	const dispose = spyOn(Input.prototype, "dispose");
	const stubs = [
		allowStorage(), dispose,
		spyOn(InputVideoTrack.prototype, "canDecode").mockResolvedValue(true),
		spyOn(VideoSampleSink.prototype, "samples").mockImplementation(() => Object.assign((async function* () {})(), {
			next: () => {
				reading.resolve();
				return pending.promise;
			},
			return: closeIterator,
		})),
	];
	const controller = new AbortController();
	const importing = processMediaFile({ file, signal: controller.signal });
	try {
		await Promise.race([reading.promise, importing.then(() => { throw new Error("No frame was requested"); })]);
		controller.abort();
		expect(await Promise.race([importing, Bun.sleep(0).then(() => "still decoding")])).toBeNull();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(closeIterator).toHaveBeenCalledTimes(1);
		const frame: VideoSample = Object.create(VideoSample.prototype, { close: { value: close } });
		pending.resolve({ done: false, value: frame });
		await pending.promise;
		expect(close).toHaveBeenCalledTimes(1);
	} finally {
		controller.abort();
		pending.resolve({ done: true, value: undefined });
		await importing;
		for (const stub of stubs) stub.mockRestore();
	}
});

test("disposing a completed probe closes the decoder while its packet read is pending", async () => {
	const bytes = new Uint8Array(await videoFile([0, 1], true));
	const reading = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	let prefetching = false;
	const input = new Input({
		source: new StreamSource({
			getSize: () => bytes.length,
			read: async (start, end) => {
				if (prefetching) {
					reading.resolve();
					await release.promise;
				}
				return bytes.subarray(start, end);
			},
		}),
		formats: [MP4],
	});
	const nextPacket = EncodedPacketSink.prototype.getNextPacket;
	const prefetch = spyOn(EncodedPacketSink.prototype, "getNextPacket").mockImplementation(
		function (this: EncodedPacketSink, packet, options) {
			prefetching ||= !options?.metadataOnly;
			return nextPacket.call(this, packet, options);
		},
	);
	// Keep the real sink and packet reader. Replace only the browser's decoder for this test.
	const sink = VideoSampleSink.prototype as VideoSampleSink & {
		_createDecoder(emit: (sample: VideoSample) => void): Promise<{
			decode(packet: EncodedPacket): void;
			getDecodeQueueSize(): number;
			flush(): Promise<void>;
			close(): void;
		}>;
	};
	const decoder = spyOn(sink, "_createDecoder").mockImplementation(async (emit) => ({
		decode: (packet) => emit(new VideoSample(new Uint8Array(4), {
			format: "RGBA", codedWidth: 1, codedHeight: 1, timestamp: packet.timestamp,
		})),
		getDecodeQueueSize: () => 0,
		flush: async () => {},
		close: () => closed.resolve(),
	}));
	try {
		const track = await input.getPrimaryVideoTrack();
		if (!track) throw new Error("Missing video test track");
		const read = withFirstVideoFrame(track, undefined, ({ timestamp }) => timestamp);
		await Promise.race([reading.promise, read.then(() => { throw new Error("Probe did not prefetch a packet"); })]);
		expect(await read).toBe(0);
		input.dispose();
		const closure = await Promise.race([closed.promise.then(() => "closed"), Bun.sleep(0).then(() => "still open")]);
		expect(closure).toBe("closed");
	} finally {
		input.dispose();
		release.resolve();
		decoder.mockRestore();
		prefetch.mockRestore();
	}
});

test.each([
	["reads the length from the file", 2.5, 2.5],
	["is refused without a readable length", Number.NaN, null],
] as const)("audio whose element reports an infinite duration %s", async (_, fileDuration, expected) => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "document");
	const element = {
		duration: Number.POSITIVE_INFINITY,
		onloadedmetadata: null as (() => void) | null,
		onerror: null as (() => void) | null,
		removeAttribute: () => {},
		load() {
			queueMicrotask(() => this.onloadedmetadata?.());
		},
		set src(_value: string) {},
	};
	Object.defineProperty(globalThis, "document", { value: { createElement: () => element }, configurable: true, writable: true });
	const track: InputAudioTrack = Object.create(InputAudioTrack.prototype, {
		computeDuration: { value: async () => fileDuration },
	});
	const stubs = [
		allowStorage(),
		spyOn(Input.prototype, "getPrimaryAudioTrack").mockResolvedValue(track),
		spyOn(toast, "error").mockImplementation(() => ""),
		spyOn(console, "error").mockImplementation(() => {}),
	];
	try {
		const file = new File(["opus"], "voice.webm", { type: "audio/webm" });
		const imported = await processMediaFile({ file, signal: new AbortController().signal });
		if (imported) releaseMediaAssetUrls(imported);
		expect(imported?.duration ?? null).toBe(expected);
	} finally {
		for (const stub of stubs) stub.mockRestore();
		if (original) Object.defineProperty(globalThis, "document", original);
		else Reflect.deleteProperty(globalThis, "document");
	}
});
