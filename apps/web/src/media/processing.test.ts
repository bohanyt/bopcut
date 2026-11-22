import { expect, mock, spyOn, test } from "bun:test";
import {
	AudioSample, AudioSampleSink, BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource,
	Input, InputAudioTrack, InputVideoTrack, MP4, Mp4OutputFormat, Output, VideoSample, VideoSampleSink,
} from "mediabunny";
import { toast } from "sonner";
import { storageService } from "@/services/storage/service";
import { processMediaFile } from "./processing";
import { releaseMediaAssetUrls } from "./url-release";

const allowStorage = () => spyOn(storageService, "canStoreFile")
	.mockResolvedValue({ canStore: true, availableBytes: null, reason: "estimate-unavailable" });

test.each(["usable", "unsupported", "corrupt", "absent"] as const)("video import with %s audio retains the original and measured FPS without a thumbnail", async (audio) => {
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
	const videoRead = spyOn(VideoSampleSink.prototype, "getSample").mockResolvedValue(frame);
	const audioRead = spyOn(AudioSampleSink.prototype, "getSample").mockImplementation(async () => {
		if (audio === "corrupt") throw new Error("Invalid audio packet");
		return sample;
	});
	const stubs = [
		spyOn(Input.prototype, "getPrimaryVideoTrack").mockResolvedValue(videoTrack),
		spyOn(Input.prototype, "getPrimaryAudioTrack").mockResolvedValue(audio === "absent" ? null : audioTrack),
		spyOn(Input.prototype, "computeDuration").mockResolvedValue(4),
		spyOn(EncodedPacketSink.prototype, "getPacket").mockResolvedValue(new EncodedPacket(Uint8Array.of(1), "key", 2, 1)),
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
			expect(warn).toHaveBeenCalledTimes(audio === "unsupported" || audio === "corrupt" ? 1 : 0);
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

async function videoFile() {
	const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
	const track = new EncodedVideoPacketSource("avc");
	output.addVideoTrack(track);
	const data = Uint8Array.from(atob("AAAAAWdkAAqs2V7ARAAAAwAEAAADAMg8SJZYAAAAAWjr48siwAAAAWWIhAAr//72c3wKa22xgQ=="), (byte) => byte.charCodeAt(0));
	await output.start();
	for (let i = 0; i < 2; i++) {
		await track.add(new EncodedPacket(data, "key", i, 1), {
			decoderConfig: { codec: "avc1.64000a", codedWidth: 16, codedHeight: 16 },
		});
	}
	await output.finalize();
	if (!output.target.buffer) throw new Error("Missing video test data");
	return output.target.buffer;
}

test("a truncated MP4 with an intact sample table is rejected before decoding", async () => {
	const video = await videoFile();
	const file = new File([video.slice(0, -8)], "truncated.mp4", { type: "video/mp4" });
	const allow = allowStorage();
	const canDecode = spyOn(InputVideoTrack.prototype, "canDecode").mockResolvedValue(true);
	const decode = spyOn(VideoSampleSink.prototype, "getSample").mockResolvedValue(null);
	const input = new Input({ source: new BlobSource(file), formats: [MP4] });
	try {
		expect(await input.computeDuration()).toBe(2);
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
		spyOn(VideoSampleSink.prototype, "getSample").mockResolvedValue(null),
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
	const pending = Promise.withResolvers<VideoSample>();
	const reading = Promise.withResolvers<void>();
	const close = mock(() => {});
	const dispose = spyOn(Input.prototype, "dispose");
	const stubs = [
		allowStorage(), dispose,
		spyOn(InputVideoTrack.prototype, "canDecode").mockResolvedValue(true),
		spyOn(VideoSampleSink.prototype, "getSample").mockImplementation(() => {
			reading.resolve();
			return pending.promise;
		}),
	];
	const controller = new AbortController();
	const importing = processMediaFile({ file, signal: controller.signal });
	try {
		await Promise.race([reading.promise, importing.then(() => { throw new Error("No frame was requested"); })]);
		controller.abort();
		expect(await Promise.race([importing, Bun.sleep(0).then(() => "still decoding")])).toBeNull();
		expect(dispose).toHaveBeenCalledTimes(1);
		pending.resolve(Object.create(VideoSample.prototype, { close: { value: close } }));
		await pending.promise;
		expect(close).toHaveBeenCalledTimes(1);
	} finally {
		controller.abort();
		pending.resolve(Object.create(VideoSample.prototype, { close: { value: close } }));
		await importing;
		for (const stub of stubs) stub.mockRestore();
	}
});
