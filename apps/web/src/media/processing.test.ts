import { expect, spyOn, test } from "bun:test";
import { Input, InputAudioTrack, InputVideoTrack, VideoSampleSink } from "mediabunny";
import { storageService } from "@/services/storage/service";
import { processMediaFile } from "./processing";
import { releaseMediaAssetUrls } from "./url-release";

test("import retains measured FPS and the original upload even without a thumbnail", async () => {
	const file = new File(["video"], "footage.mkv", { type: "application/octet-stream" });
	const fps = 30_000 / 1_001;
	const videoTrack: InputVideoTrack = Object.create(InputVideoTrack.prototype, {
		displayWidth: { value: 16 },
		displayHeight: { value: 9 },
		canDecode: { value: async () => true },
		codec: { value: "avc" },
		computePacketStats: { value: async () => ({ averagePacketRate: fps }) },
	});
	const audioTrack: InputAudioTrack = Object.create(InputAudioTrack.prototype, {
		codec: { value: null },
	});
	const stubs = [
		spyOn(Input.prototype, "getPrimaryVideoTrack").mockResolvedValue(videoTrack),
		spyOn(Input.prototype, "getPrimaryAudioTrack").mockResolvedValue(audioTrack),
		spyOn(Input.prototype, "computeDuration").mockResolvedValue(1),
		spyOn(VideoSampleSink.prototype, "getSample").mockResolvedValue(null),
		spyOn(storageService, "canStoreFile").mockResolvedValue({ canStore: true, availableBytes: null, reason: "estimate-unavailable" }),
	];
	try {
		const imported = await processMediaFile({ file, signal: new AbortController().signal });
		try {
			expect(imported).toMatchObject({ type: "video", duration: 1, fps, hasAudio: true, thumbnailUrl: undefined });
			expect(imported?.file).toBe(file);
		} finally {
			if (imported) releaseMediaAssetUrls(imported);
		}
	} finally {
		for (const stub of stubs) stub.mockRestore();
	}
});

test("a failed probe rejects a newly recognized video while keeping the concrete MIME path", async () => {
	const allow = spyOn(storageService, "canStoreFile").mockResolvedValue({ canStore: true, availableBytes: null, reason: "estimate-unavailable" });
	try {
		const signal = new AbortController().signal;
		const inferred = new File(["not video"], "footage.mkv", { type: "application/octet-stream" });
		const declared = new File(["not video"], "footage.mkv", { type: "video/x-matroska" });
		expect(await processMediaFile({ file: inferred, signal })).toBeNull();
		const asset = await processMediaFile({ file: declared, signal });
		try {
			expect(asset?.file).toBe(declared);
		} finally {
			if (asset) releaseMediaAssetUrls(asset);
		}
	} finally {
		allow.mockRestore();
	}
});
