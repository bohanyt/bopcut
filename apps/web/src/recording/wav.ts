export function alignedStartFrame({
	playbackTime,
	sampleRate,
	inputLatency = 0,
	outputLatency = 0,
}: {
	playbackTime: number;
	sampleRate: number;
	inputLatency?: number;
	outputLatency?: number;
}): number {
	// The worklet stamps input on arrival. Sound at the play cue reaches the listener
	// after output latency and reaches the capture graph after input latency.
	return Math.round((playbackTime + inputLatency + outputLatency) * sampleRate);
}

export function trimPcmStart(chunks: readonly Int16Array<ArrayBuffer>[], frames: number) {
	const trimmed: Int16Array<ArrayBuffer>[] = [];
	for (const chunk of chunks) {
		if (frames < chunk.length) trimmed.push(frames > 0 ? chunk.subarray(frames) : chunk);
		frames = Math.max(0, frames - chunk.length);
	}
	return trimmed;
}

export function wavParts(chunks: readonly Int16Array<ArrayBuffer>[], sampleRate: number) {
	const bytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const header = new DataView(new ArrayBuffer(44));
	header.setUint32(0, 0x52494646); // RIFF
	header.setUint32(4, 36 + bytes, true);
	header.setUint32(8, 0x57415645); // WAVE
	header.setUint32(12, 0x666d7420); // fmt
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true);
	header.setUint16(22, 1, true);
	header.setUint32(24, sampleRate, true);
	header.setUint32(28, sampleRate * 2, true);
	header.setUint16(32, 2, true);
	header.setUint16(34, 16, true);
	header.setUint32(36, 0x64617461); // data
	header.setUint32(40, bytes, true);

	if (new Uint8Array(Uint16Array.of(1).buffer)[0] === 1) return [header, ...chunks];
	// WAV is little-endian even on a big-endian host.
	return [header, ...chunks.map((chunk) => {
		const view = new DataView(new ArrayBuffer(chunk.byteLength));
		chunk.forEach((sample, i) => view.setInt16(i * 2, sample, true));
		return view;
	})];
}
