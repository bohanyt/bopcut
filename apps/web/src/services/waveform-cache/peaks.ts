export const WAVEFORM_BUCKET_SIZE = 128;

/** Takes whole buckets, except for the last bucket of the source. */
export function waveformPeaks(channels: Float32Array[], length: number): Float32Array<ArrayBuffer> {
	const peaks = new Float32Array(Math.max(1, Math.ceil(length / WAVEFORM_BUCKET_SIZE)));
	for (const samples of channels) {
		for (let bucket = 0; bucket < peaks.length; bucket++) {
			const start = bucket * WAVEFORM_BUCKET_SIZE;
			const end = Math.min(length, start + WAVEFORM_BUCKET_SIZE);
			let peak = peaks[bucket];
			for (let sample = start; sample < end; sample++) {
				const amplitude = Math.abs(samples[sample]);
				if (amplitude > peak) peak = amplitude;
			}
			peaks[bucket] = peak;
		}
	}
	return peaks;
}
