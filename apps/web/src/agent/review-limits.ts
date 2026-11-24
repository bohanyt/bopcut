export const reviewTimeout = (seconds: number) => Math.ceil(Math.max(180, 120 + 0.3 * seconds) * 1000);

export function reviewScratchBytes(seconds: number, fps: number, sampleRate: number, channels: number) {
	// Gray 64×36 bytes, timestamp rows (up to 128 bytes), and native-rate float PCM.
	return Math.ceil(seconds) * (Math.ceil(fps) * (64 * 36 + 128) + sampleRate * channels * 4);
}

export function requireReviewScratch(free: number, needed: number) {
	if (free >= needed + 2 * 1024 ** 3) return;
	const mib = (bytes: number) => `${Math.ceil(bytes / 1024 ** 2)} MiB`;
	throw new Error(`Insufficient scratch space: ${mib(free)} free, ${mib(needed)} needed for review plus 2 GiB reserved.`);
}
