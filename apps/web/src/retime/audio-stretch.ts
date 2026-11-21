import { SoundTouch } from "soundtouchjs";
import { createAudioCheckpoint, STEREO_CHANNELS, type DecodedAudioWindow } from "@/media/audio-window";

type ReadWindow = (start: number, end: number) => Promise<DecodedAudioWindow | null>;

/** Pull bounded PCM blocks through one pitch processor so overlap state survives block boundaries. */
export function createPitchReader({
	readWindow, sourceStart, sourceEnd, rate, sampleRate, signal,
}: {
	readWindow: ReadWindow;
	sourceStart: number;
	sourceEnd: number;
	rate: number;
	sampleRate: number;
	signal?: AbortSignal;
}): (length: number) => Promise<AudioBuffer> {
	const processor = new SoundTouch();
	processor.stretch.setParameters(sampleRate, 0, 0, 0);
	processor.tempo = rate;
	const inputFrames = Math.ceil((sourceEnd - sourceStart) * sampleRate);
	const quantum = Math.ceil(sampleRate * Math.min(1, rate) / 8);
	const scratch = new Float32Array(quantum * 2);
	let inputFrame = 0;
	let window: DecodedAudioWindow | null = null;

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
					const start = sourceStart + inputFrame / sampleRate;
					const end = sourceStart + (inputFrame + frames) / sampleRate;
					if (!window || end + 1 / 8000 > window.start + window.buffer.duration) {
						const windowEnd = sourceStart + Math.min(inputFrames, inputFrame + sampleRate) / sampleRate;
						window = await readWindow(start, windowEnd + 1 / 8000);
					}
					if (!window) return output;
					const nativeRate = window.buffer.sampleRate;
					const inputLeft = window.buffer.getChannelData(0);
					const inputRight = window.buffer.getChannelData(1);
					for (let i = 0; i < frames; i++) {
						const position = (start - window.start + i / sampleRate) * nativeRate;
						const lower = Math.floor(position);
						const fraction = position - lower;
						scratch[i * 2] = (inputLeft[lower] ?? 0) * (1 - fraction) + (inputLeft[lower + 1] ?? 0) * fraction;
						scratch[i * 2 + 1] = (inputRight[lower] ?? 0) * (1 - fraction) + (inputRight[lower + 1] ?? 0) * fraction;
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
