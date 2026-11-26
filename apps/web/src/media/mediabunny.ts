import {
	AudioSampleSink,
	type Input,
	type InputVideoTrack,
} from "mediabunny";
import { EXPORT_SAMPLE_RATE as SAMPLE_RATE, mixTimelineAudio } from "@/media/audio-mixdown";
import type { SceneTracks, TScene } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND } from "@/wasm";
import { renderThumbnailDataUrl } from "./thumbnail";
import { checkPacketTail, getDecodableVideoTrack, withFirstSample, withFirstVideoFrame, withVideoInput } from "./video-probe";

export type VideoFileData = {
	duration: number;
	width: number;
	height: number;
	fps: number;
	hasAudio: boolean;
	audioUnavailable: boolean;
	/** HDR (PQ or HLG): the editor shows and exports it as 8-bit SDR, so colors can look different. */
	hdr: boolean;
	thumbnailUrl: string | null;
};

export async function readVideoFile({
	file,
	signal,
}: {
	file: File;
	signal?: AbortSignal;
}): Promise<VideoFileData> {
	return withVideoInput(file, signal, async (input) => {
		const videoTrack = await getDecodableVideoTrack(input);
		signal?.throwIfAborted();
		const duration = await videoTrack.computeDuration();
		if (!Number.isFinite(duration) || duration <= 0) {
			throw new Error("The file does not have a finite video duration");
		}
		await checkPacketTail(videoTrack, signal);
		const packetStats = await videoTrack.computePacketStats(100);
		// Color metadata only feeds a notice: a file without readable metadata imports as before.
		// The DOM type lists only SDR curves; Mediabunny also reports "pq" and "hlg".
		const transfer: string | null | undefined = await Promise.resolve().then(() => videoTrack.getColorSpace()).then(({ transfer }) => transfer, () => null);
		const { displayWidth: width, displayHeight: height } = videoTrack;
		const thumbnailUrl = await firstFrameThumbnail(videoTrack, signal);
		const audio = await readVideoAudio(input, signal);

		return {
			duration: Math.max(duration, audio.duration),
			width,
			height,
			fps: packetStats.averagePacketRate,
			hasAudio: audio.duration > 0,
			audioUnavailable: audio.unavailable,
			hdr: transfer === "pq" || transfer === "hlg",
			thumbnailUrl,
		};
	});
}

function firstFrameThumbnail(track: InputVideoTrack, signal?: AbortSignal) {
	return withFirstVideoFrame(track, signal, (frame) => {
		try {
			return renderThumbnailDataUrl({
				width: track.displayWidth, height: track.displayHeight,
				draw: ({ context, width, height }) => frame.draw(context, 0, 0, width, height),
			});
		} catch {
			return null;
		}
	});
}

export function readVideoThumbnail(file: File, signal: AbortSignal): Promise<string | null> {
	return withVideoInput(file, signal, async (input) =>
		firstFrameThumbnail(await getDecodableVideoTrack(input), signal),
	);
}

async function readVideoAudio(input: Input, signal?: AbortSignal) {
	const unavailable = { duration: 0, unavailable: true };
	try {
		signal?.throwIfAborted();
		const track = await input.getPrimaryAudioTrack();
		if (!track) return { duration: 0, unavailable: false };
		if (!await track.canDecode()) return unavailable;
		const duration = await track.computeDuration();
		if (!Number.isFinite(duration) || duration <= 0) return unavailable;
		await checkPacketTail(track, signal);
		const timestamp = await track.getFirstTimestamp();
		signal?.throwIfAborted();
		// Some codecs consume priming packets before they emit a decoded sample.
		const sample = await withFirstSample(new AudioSampleSink(track).samples(timestamp), signal, Boolean);
		return sample ? { duration, unavailable: false } : unavailable;
	} catch {
		signal?.throwIfAborted();
		return unavailable;
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
