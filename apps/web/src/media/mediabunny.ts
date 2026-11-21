import {
	Input,
	ALL_FORMATS,
	BlobSource,
	VideoSampleSink,
	type VideoCodec,
} from "mediabunny";
import { EXPORT_SAMPLE_RATE as SAMPLE_RATE, mixTimelineAudio } from "@/media/audio-mixdown";
import type { SceneTracks, TScene } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND } from "@/wasm";
import { renderThumbnailDataUrl } from "./thumbnail";

export type VideoFileData = {
	duration: number;
	width: number;
	height: number;
	fps: number;
	hasAudio: boolean;
	codec: VideoCodec | null;
	canDecode: boolean;
	thumbnailUrl: string | null;
};

export async function readVideoFile({
	file,
}: {
	file: File;
}): Promise<VideoFileData> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const duration = await input.computeDuration();
		const videoTrack = await input.getPrimaryVideoTrack();

		if (!videoTrack) {
			throw new Error("No video track found in the file");
		}

		const canDecode = await videoTrack.canDecode();
		const packetStats = await videoTrack.computePacketStats(100);
		const audioTrack = await input.getPrimaryAudioTrack();

		let thumbnailUrl: string | null = null;
		if (canDecode) {
			const sink = new VideoSampleSink(videoTrack);
			const frame = await sink.getSample(1);
			if (frame) {
				try {
					thumbnailUrl = renderThumbnailDataUrl({
						width: videoTrack.displayWidth,
						height: videoTrack.displayHeight,
						draw: ({ context, width, height }) => {
							frame.draw(context, 0, 0, width, height);
						},
					});
				} finally {
					frame.close();
				}
			}
		}

		return {
			duration,
			width: videoTrack.displayWidth,
			height: videoTrack.displayHeight,
			fps: packetStats.averagePacketRate,
			hasAudio: audioTrack !== null,
			codec: videoTrack.codec,
			canDecode,
			thumbnailUrl,
		};
	} finally {
		input.dispose();
	}
}

const NUM_CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const EMPTY_TIMELINE_SILENT_DURATION_SECONDS = 0.1;
const MIN_SILENT_DURATION_SECONDS = 0.001;

export const extractTimelineAudio = async ({
	tracks,
	mediaAssets,
	totalDuration,
	onProgress,
	scenes,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	totalDuration: number;
	onProgress?: (progress: number) => void;
	scenes?: TScene[];
}): Promise<Blob> => {
	const duration = totalDuration === 0 ? EMPTY_TIMELINE_SILENT_DURATION_SECONDS : totalDuration / TICKS_PER_SECOND;
	const maxSamples = Math.ceil(Math.max(MIN_SILENT_DURATION_SECONDS, duration) * SAMPLE_RATE);
	if (maxSamples * NUM_CHANNELS * BYTES_PER_SAMPLE > 0xffffffff - 36) {
		throw new Error("Timeline audio exceeds the WAV size limit.");
	}

	if (totalDuration !== 0) onProgress?.(10);
	const parts: Blob[] = [];
	let samples = 0;
	for await (const block of mixTimelineAudio({ tracks, mediaAssets, duration: totalDuration, scenes })) {
		const left = block.getChannelData(0);
		const right = block.getChannelData(1);
		const pcm = new ArrayBuffer(block.length * NUM_CHANNELS * BYTES_PER_SAMPLE);
		const view = new DataView(pcm);
		for (let i = 0; i < block.length; i++) {
			writePcmSample(view, i * 4, left[i]);
			writePcmSample(view, i * 4 + 2, right[i]);
		}
		samples += block.length;
		parts.push(new Blob([pcm]));
	}

	if (!parts.length) {
		let remainingBytes = maxSamples * NUM_CHANNELS * BYTES_PER_SAMPLE;
		const silence = new Blob([new ArrayBuffer(Math.min(remainingBytes, SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE))]);
		while (remainingBytes >= silence.size) {
			parts.push(silence);
			remainingBytes -= silence.size;
		}
		if (remainingBytes) parts.push(silence.slice(0, remainingBytes));
		samples = maxSamples;
	}
	if (totalDuration !== 0) onProgress?.(90);
	const blob = new Blob([createWavHeader(samples), ...parts], { type: "audio/wav" });
	if (totalDuration !== 0) onProgress?.(100);
	return blob;
};

function writePcmSample(view: DataView, offset: number, value: number): void {
	const sample = Math.max(-1, Math.min(1, value));
	view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
}

function createWavHeader(numSamples: number): ArrayBuffer {
	const dataSize = numSamples * NUM_CHANNELS * BYTES_PER_SAMPLE;
	const buffer = new ArrayBuffer(44);
	const view = new DataView(buffer);

	writeString({ view, offset: 0, str: "RIFF" });
	view.setUint32(4, 36 + dataSize, true);
	writeString({ view, offset: 8, str: "WAVE" });
	writeString({ view, offset: 12, str: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, NUM_CHANNELS, true);
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE, true);
	view.setUint16(32, NUM_CHANNELS * BYTES_PER_SAMPLE, true);
	view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
	writeString({ view, offset: 36, str: "data" });
	view.setUint32(40, dataSize, true);
	return buffer;
}

function writeString({
	view,
	offset,
	str,
}: {
	view: DataView;
	offset: number;
	str: string;
}): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}
