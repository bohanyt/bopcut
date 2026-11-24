"use client";

import { createAudioContext } from "@/media/audio";
import { yieldAudioTask } from "@/media/audio-window";
import type { SourceWaveformSummary } from "@/media/waveform-summary";
import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import { mediaFileVersion } from "@/services/storage/media-file-version";
import { waveformPeaks, WAVEFORM_BUCKET_SIZE } from "./peaks";

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: File;
	audioUrl?: string;
}

type Entry = {
	controller: AbortController;
	promise: Promise<SourceWaveformSummary>;
	version?: string;
	bytes?: number;
};

const LIMIT_BYTES = 8 * 1024 * 1024;
const LIMIT_ENTRIES = 64;

function sourceFileVersion(file: File): string {
	return JSON.stringify([file.name, file.size, file.lastModified, mediaFileVersion(file)]);
}

export class WaveformCache {
	private summaries = new Map<string, Entry>();
	private queue: Promise<unknown> = Promise.resolve();
	private persisted = new IndexedDBAdapter<SourceWaveformSummary>({
		dbName: "bopencut-waveform-cache",
		storeName: "summaries",
	});

	getSourceSummary(args: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const { sourceKey } = args;
		const version = args.sourceFile ? sourceFileVersion(args.sourceFile) : args.audioUrl;
		const existing = this.summaries.get(sourceKey);
		if (existing && existing.version === version) {
			this.summaries.delete(sourceKey);
			this.summaries.set(sourceKey, existing);
			return existing.promise;
		}

		existing?.controller.abort();
		const controller = new AbortController();
		const promise = this.queue
			.then(() => yieldAudioTask(controller.signal))
			.then(() => this.buildSummary(args, version, controller.signal))
			.then((summary) => {
				if (this.summaries.get(sourceKey) === entry) {
					entry.bytes = summary.amplitudes.byteLength;
					this.trim();
				}
				return summary;
			})
			.catch((error) => {
				if (this.summaries.get(sourceKey) === entry) this.summaries.delete(sourceKey);
				throw error;
			});
		const entry: Entry = { controller, promise, version };
		this.queue = promise.catch(() => undefined);
		this.summaries.delete(sourceKey);
		this.summaries.set(sourceKey, entry);
		return promise;
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.get(sourceKey)?.controller.abort();
		this.summaries.delete(sourceKey);
	}

	clearAll(): void {
		for (const { controller } of this.summaries.values()) controller.abort();
		this.summaries.clear();
	}

	private trim(): void {
		const completed = [...this.summaries].filter(([, entry]) => entry.bytes !== undefined);
		let bytes = completed.reduce((sum, [, entry]) => sum + (entry.bytes ?? 0), 0);
		let count = completed.length;
		for (const [key, entry] of completed) {
			const size = entry.bytes ?? 0;
			if (size > LIMIT_BYTES || count > LIMIT_ENTRIES || bytes > LIMIT_BYTES) {
				this.summaries.delete(key);
				bytes -= size;
				count--;
			}
		}
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs, version: string | undefined, signal: AbortSignal): Promise<SourceWaveformSummary> {
		if (audioBuffer) return summarizeAudio(sourceKey, audioBuffer, signal);
		// Keep decodeAudioData's original sample rate. A different output device can select a
		// different rate, so the persisted summary must include it in the cache key.
		const audioContext = createAudioContext();
		try {
			const key = sourceFile && sourceKey.startsWith("media:") && JSON.stringify([
				1, sourceKey, version, audioContext.sampleRate,
			]);
			if (key) {
				const cached = await this.persisted.get(key).catch(() => null);
				signal.throwIfAborted();
				if (cached) return cached;
			}

			let data: ArrayBuffer;
			if (sourceFile) {
				data = await sourceFile.arrayBuffer();
			} else if (audioUrl) {
				const response = await fetch(audioUrl, { signal });
				if (!response.ok) throw new Error(`Failed to fetch waveform source: ${response.status}`);
				data = await response.arrayBuffer();
			} else {
				throw new Error(`No waveform source available for ${sourceKey}`);
			}
			signal.throwIfAborted();
			// Web Audio decodes off the main thread and takes ownership of the input bytes.
			audioBuffer = await audioContext.decodeAudioData(data);
			const summary = await summarizeAudio(sourceKey, audioBuffer, signal);
			if (key) void this.persisted.set({ key, value: summary }).catch(() => undefined);
			return summary;
		} finally {
			await audioContext.close().catch(() => undefined);
		}
	}
}

async function summarizeAudio(sourceKey: string, buffer: AudioBuffer, signal: AbortSignal): Promise<SourceWaveformSummary> {
	const { length, sampleRate, numberOfChannels } = buffer;
	const amplitudes = new Float32Array(Math.max(1, Math.ceil(length / WAVEFORM_BUCKET_SIZE)));
	// Cap the total number of samples copied per main-thread batch, including multichannel sources.
	const bucketsPerBatch = Math.max(1, Math.floor(1024 / numberOfChannels));
	const samplesPerBatch = bucketsPerBatch * WAVEFORM_BUCKET_SIZE;
	let worker: Worker | undefined;
	try {
		if (typeof Worker !== "undefined") {
			try {
				worker = new Worker(new URL("./peaks.worker.ts", import.meta.url));
			} catch {
				// Browsers that disallow workers can still build a summary in cooperative batches.
			}
		}
		for (let start = 0; start < length; start += samplesPerBatch) {
			await yieldAudioTask(signal);
			const size = Math.min(length - start, samplesPerBatch);
			const read = () => Array.from({ length: numberOfChannels }, (_, channel) => {
				const samples = new Float32Array(size);
				buffer.copyFromChannel(samples, channel, start);
				return samples;
			});
			let peaks: Float32Array | undefined;
			if (worker) {
				try {
					peaks = await workerPeaks(worker, read(), size, signal);
				} catch {
					signal.throwIfAborted();
					worker.terminate();
					worker = undefined;
				}
			}
			peaks ??= waveformPeaks(read(), size);
			amplitudes.set(peaks, start / WAVEFORM_BUCKET_SIZE);
		}
		return { sourceKey, sampleRate, totalSamples: length, bucketSize: WAVEFORM_BUCKET_SIZE, amplitudes };
	} finally {
		worker?.terminate();
	}
}

function workerPeaks(worker: Worker, channels: Float32Array<ArrayBuffer>[], length: number, signal: AbortSignal) {
	let abort: () => void;
	return new Promise<Float32Array>((resolve, reject) => {
		abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		worker.onmessage = ({ data }: MessageEvent<Float32Array>) => resolve(data);
		worker.onerror = (error) => reject(error);
		worker.postMessage({ channels, length }, channels.map(({ buffer }) => buffer));
	}).finally(() => {
		signal.removeEventListener("abort", abort);
		worker.onmessage = null;
		worker.onerror = null;
	});
}

export const waveformCache = new WaveformCache();
