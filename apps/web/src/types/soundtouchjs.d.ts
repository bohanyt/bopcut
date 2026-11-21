declare module "soundtouchjs" {
	interface FifoSampleBuffer {
		readonly frameCount: number;
		putSamples(samples: Float32Array, position: number, frames: number): void;
		receiveSamples(target: Float32Array, frames: number): void;
	}

	export class SoundTouch {
		tempo: number;
		readonly inputBuffer: FifoSampleBuffer;
		readonly outputBuffer: FifoSampleBuffer;
		readonly stretch: {
			setParameters(sampleRate: number, sequenceMs: number, seekWindowMs: number, overlapMs: number): void;
		};
		process(): void;
	}
}
