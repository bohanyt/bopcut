import { createAudioCheckpoint } from "@/media/audio-window";

const MASTER_LIMITER_THRESHOLD_DB = -1;
const MASTER_LIMITER_KNEE_DB = 0;
const MASTER_LIMITER_RATIO = 20;
const MASTER_LIMITER_ATTACK_SECONDS = 0.001;
const MASTER_LIMITER_RELEASE_SECONDS = 0.12;
const MASTER_OUTPUT_HEADROOM = 0.98;

export function createAudioMasteringChain({
	audioContext,
	destination,
}: {
	audioContext: AudioContext | OfflineAudioContext;
	destination: AudioNode;
}): {
	input: GainNode;
} {
	const input = audioContext.createGain();
	const limiter = audioContext.createDynamicsCompressor();
	const outputGain = audioContext.createGain();

	limiter.threshold.value = MASTER_LIMITER_THRESHOLD_DB;
	limiter.knee.value = MASTER_LIMITER_KNEE_DB;
	limiter.ratio.value = MASTER_LIMITER_RATIO;
	limiter.attack.value = MASTER_LIMITER_ATTACK_SECONDS;
	limiter.release.value = MASTER_LIMITER_RELEASE_SECONDS;
	outputGain.gain.value = MASTER_OUTPUT_HEADROOM;

	input.connect(limiter);
	limiter.connect(outputGain);
	outputGain.connect(destination);

	return { input };
}


/** A linked peak limiter with continuous gain across encoded blocks. */
export function createBlockMastering(sampleRate: number) {
	const recovery = 1 - Math.exp(-1 / (sampleRate * MASTER_LIMITER_RELEASE_SECONDS));
	let gain = 1;
	const process = async (buffer: AudioBuffer, signal?: AbortSignal): Promise<void> => {
		const left = buffer.getChannelData(0);
		const right = buffer.getChannelData(1);
		const checkpoint = createAudioCheckpoint(signal);
		for (let offset = 0; offset < buffer.length; offset += 4096) {
			signal?.throwIfAborted();
			for (let index = offset; index < Math.min(offset + 4096, buffer.length); index++) {
				const peak = Math.max(Math.abs(left[index]), Math.abs(right[index]));
				const ceiling = peak > MASTER_OUTPUT_HEADROOM ? MASTER_OUTPUT_HEADROOM / peak : 1;
				gain = Math.min(ceiling, gain + (1 - gain) * recovery);
				left[index] *= gain;
				right[index] *= gain;
			}
			await checkpoint();
		}
	};
	return {
		process,
		advanceSilence(samples: number) {
			gain = 1 - (1 - gain) * Math.pow(1 - recovery, samples);
		},
	};
}
