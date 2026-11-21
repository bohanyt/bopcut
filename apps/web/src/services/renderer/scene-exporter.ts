import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { CanvasRenderer } from "./canvas-renderer";
import { waitWithAbort } from "@/utils/abort";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	onMediaFailure?: (mediaId: string, error: unknown) => void;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

// Mediabunny's MP4 timescale when no fixed frame rate metadata is supplied.
const MP4_MIN_SAMPLE_DURATION = 1 / 57_600;

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		onMediaFailure,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
			exactFrames: true,
			onMediaFailure,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
	}

	async export({
		rootNode,
		signal,
	}: {
		rootNode: RootNode;
		signal?: AbortSignal;
	}): Promise<ArrayBuffer | null> {
		signal?.throwIfAborted();
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const frameTicksNumerator = TICKS_PER_SECOND * fps.denominator;
		const frameCount = Math.ceil((rootNode.duration * fps.numerator) / frameTicksNumerator);
		const frameDuration = fps.denominator / fps.numerator;
		const duration = rootNode.duration / TICKS_PER_SECOND;

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		try {
			const videoSource = new CanvasSource(this.renderer.getOutputCanvas(), {
				codec: this.format === "webm" ? "vp9" : "avc",
				bitrate: qualityMap[this.quality],
			});

			// WebM writes a default duration for its blocks. MP4 can time a shorter last sample;
			// omitting the fixed-rate metadata lets it use a finer timescale for that sample.
			output.addVideoTrack(videoSource, this.format === "webm" ? { frameRate: fpsFloat } : {});

			let audioSource: AudioBufferSource | null = null;
			if (this.shouldIncludeAudio && this.audioBuffer) {
				let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

				if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
					const { supported } = await waitWithAbort(AudioEncoder.isConfigSupported({
						codec: "mp4a.40.2",
						sampleRate: this.audioBuffer.sampleRate,
						numberOfChannels: this.audioBuffer.numberOfChannels,
						bitrate: 192000,
					}), signal);
					if (!supported) audioCodec = "opus";
				}

				audioSource = new AudioBufferSource({
					codec: audioCodec,
					bitrate: qualityMap[this.quality],
				});
				output.addAudioTrack(audioSource);
			}

			await waitWithAbort(output.start(), signal);

			if (audioSource && this.audioBuffer) {
				signal?.throwIfAborted();
				await waitWithAbort(audioSource.add(this.audioBuffer), signal);
				audioSource.close();
			}

			for (let i = 0; i < frameCount; i++) {
				const timeTicks = Math.min(rootNode.duration - 1, Math.round((i * frameTicksNumerator) / fps.numerator));
				const timeSeconds = (i * fps.denominator) / fps.numerator;
				const sampleDuration = this.format === "mp4" && i === frameCount - 1
					? Math.max(MP4_MIN_SAMPLE_DURATION, Math.min(frameDuration, duration - timeSeconds))
					: frameDuration;
				signal?.throwIfAborted();
				await this.renderer.render({ node: rootNode, time: timeTicks, signal });
				signal?.throwIfAborted();
				await waitWithAbort(videoSource.add(timeSeconds, sampleDuration), signal);

				this.emit("progress", i / frameCount);
			}

			signal?.throwIfAborted();
			videoSource.close();
			await waitWithAbort(output.finalize(), signal);
			signal?.throwIfAborted();
			this.emit("progress", 1);

			const buffer = output.target.buffer;
			if (!buffer) {
				this.emit("error", new Error("Failed to export video"));
				return null;
			}

			this.emit("complete", buffer);
			return buffer;
		} catch (error) {
			if (output.state === "pending" || output.state === "started") {
				void output.cancel().catch((cleanup) => console.warn("Failed to cancel export output:", cleanup));
			}
			if (!signal?.aborted) throw error;
			this.emit("cancelled");
			return null;
		} finally {
			this.renderer.videoCache.clear();
		}
	}
}
