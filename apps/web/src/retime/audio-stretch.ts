import { SoundTouch } from "soundtouchjs";
import { createStereoSampler, resamplePadding } from "@/media/audio-resample";
import { createAudioCheckpoint, STEREO_CHANNELS, type DecodedAudioWindow } from "@/media/audio-window";

type ReadWindow = (start: number, end: number) => Promise<DecodedAudioWindow | null>;

/** Pull bounded PCM blocks through one pitch processor, starting at readStart within the source trim. */
export function createPitchReader({
	readWindow, sourceStart, sourceEnd, boundSourceEnd = true, readStart = sourceStart, rate, sampleRate, signal,
}: {
	readWindow: ReadWindow;
	sourceStart: number;
	sourceEnd: number;
	boundSourceEnd?: boolean;
	readStart?: number;
	rate: number;
	sampleRate: number;
	signal?: AbortSignal;
}): (length: number) => Promise<AudioBuffer> {
	const processor = new SoundTouch();
	processor.stretch.setParameters(sampleRate, 0, 0, 0);
	processor.tempo = rate;
	const inputFrames = Math.ceil((sourceEnd - readStart) * sampleRate);
	const quantum = Math.ceil(sampleRate * Math.min(1, rate) / 8);
	const scratch = new Float32Array(quantum * 2);
	const padding = resamplePadding(sampleRate);
	const stereo = new Float64Array(2);
	let inputFrame = 0;
	let window: DecodedAudioWindow | null = null;
	let sample: ReturnType<typeof createStereoSampler> | undefined;

	return async (length) => {
		const output = new AudioBuffer({ numberOfChannels: STEREO_CHANNELS, length, sampleRate });
		const left = output.getChannelData(0);
		const right = output.getChannelData(1);
		let written = 0;
		const checkpoint = createAudioCheckpoint(signal);
		while (written < length) {
			signal?.throwIfAborted();
			const ready = Math.min(length - written, quantum, processor.outputBuffer.frameCount);
			if (ready) {
				processor.outputBuffer.receiveSamples(scratch, ready);
				for (let i = 0; i < ready; i++) {
					left[written + i] = scratch[i * 2];
					right[written + i] = scratch[i * 2 + 1];
				}
				written += ready;
			} else {
				const frames = Math.max(0, Math.min(quantum, inputFrames - inputFrame));
				scratch.fill(0);
				if (frames) {
					const start = readStart + inputFrame / sampleRate;
					const end = readStart + (inputFrame + frames) / sampleRate;
					if (!window || end + padding > window.start + window.buffer.duration) {
						const windowEnd = readStart + Math.min(inputFrames, inputFrame + sampleRate) / sampleRate;
						window = await readWindow(start - padding, windowEnd + padding);
						if (!window) return output;
						const nativeRate = window.buffer.sampleRate;
						const windowStart = Math.round(window.start * nativeRate);
						// Convert the actual trim independently of the seek offset and decoder window.
						sample = createStereoSampler(window.buffer, nativeRate / sampleRate, {
							start: Math.ceil(sourceStart * nativeRate - 1e-7) - windowStart,
							end: boundSourceEnd ? Math.ceil(sourceEnd * nativeRate - 1e-7) - windowStart : undefined,
						});
					}
					if (!window) return output;
					const nativeRate = window.buffer.sampleRate;
					for (let i = 0; i < frames; i++) {
						const position = (start - window.start + i / sampleRate) * nativeRate;
						sample!(position, stereo);
						scratch[i * 2] = stereo[0];
						scratch[i * 2 + 1] = stereo[1];
					}
					inputFrame += frames;
				}
				// Continue with zero padding at the source end to drain the final overlap.
				processor.inputBuffer.putSamples(scratch, 0, quantum);
				processor.process();
			}
			await checkpoint();
		}
		return output;
	};
}
