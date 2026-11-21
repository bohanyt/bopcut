import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, type WrappedAudioBuffer } from "mediabunny";
import { waitWithAbort } from "@/utils/abort";

export const STEREO_CHANNELS = 2;

export interface DecodedAudioWindow {
	buffer: AudioBuffer;
	start: number;
}

export function yieldAudioTask(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const { port1, port2 } = new MessageChannel();
		port1.onmessage = () => {
			port1.close();
			port2.close();
			if (signal?.aborted) reject(signal.reason);
			else resolve();
		};
		port2.postMessage(null);
	});
}

export function createAudioCheckpoint(signal?: AbortSignal): () => Promise<void> | undefined {
	let deadline = performance.now() + 8;
	return () => {
		signal?.throwIfAborted();
		if (performance.now() < deadline) return;
		return yieldAudioTask(signal).then(() => {
			deadline = performance.now() + 8;
		});
	};
}

/** Copy a packet into stereo using speaker order. Mono is duplicated and LFE is omitted. */
function copyStereo({
	source, target, from, to, offset,
}: {
	source: AudioBuffer;
	target: AudioBuffer;
	from: number;
	to: number;
	offset: number;
}): void {
	const count = source.numberOfChannels;
	const channels = Array.from({ length: count }, (_, index) => source.getChannelData(index));
	const left = target.getChannelData(0);
	const right = target.getChannelData(1);
	if (count <= 2) {
		left.set(channels[0].subarray(from, to), offset);
		right.set(channels[count - 1].subarray(from, to), offset);
		return;
	}

	const surround = Math.SQRT1_2;
	for (let i = from; i < to; i++, offset++) {
		if (count === 4) {
			left[offset] = 0.5 * (channels[0][i] + channels[2][i]);
			right[offset] = 0.5 * (channels[1][i] + channels[3][i]);
			continue;
		}

		const center = surround * channels[2][i];
		const rear = count === 7 ? 0.5 * channels[6][i] : 0;
		const surroundIndex = count === 5 ? 3 : 4;
		left[offset] = channels[0][i] + center + rear +
			surround * ((channels[surroundIndex]?.[i] ?? 0) + (count >= 8 ? channels[6][i] : 0));
		right[offset] = channels[1][i] + center + rear +
			surround * ((channels[surroundIndex + 1]?.[i] ?? 0) + (count >= 8 ? channels[7][i] : 0));
		for (let channel = 8; channel < count; channel += 2) {
			const extra = channels[channel][i] * surround;
			left[offset] += extra;
			right[offset] += (channels[channel + 1]?.[i] ?? channels[channel][i]) * surround;
		}
	}
}

export function downmixToStereo(buffer: AudioBuffer): AudioBuffer {
	if (buffer.numberOfChannels <= STEREO_CHANNELS) return buffer;
	const stereo = new AudioBuffer({
		numberOfChannels: STEREO_CHANNELS,
		length: buffer.length,
		sampleRate: buffer.sampleRate,
	});
	copyStereo({ source: buffer, target: stereo, from: 0, to: buffer.length, offset: 0 });
	return stereo;
}

export function openAudioInput(file: Blob): Input {
	return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

function createWindow(start: number, end: number, sampleRate: number): DecodedAudioWindow {
	const firstSample = Math.floor(start * sampleRate);
	const length = Math.max(1, Math.ceil(end * sampleRate) - firstSample);
	return {
		start: firstSample / sampleRate,
		buffer: new AudioBuffer({ numberOfChannels: STEREO_CHANNELS, length, sampleRate }),
	};
}

function copyPacket(window: DecodedAudioWindow, packet: AudioBuffer, timestamp: number): void {
	const { sampleRate, length } = window.buffer;
	if (packet.sampleRate !== sampleRate) throw new Error("Audio sample rate changed during decoding");
	const firstSample = Math.round(window.start * sampleRate);
	const packetStart = Math.round(timestamp * sampleRate);
	const from = Math.max(0, Math.max(0, firstSample) - packetStart);
	const to = Math.min(packet.length, firstSample + length - packetStart);
	if (from < to) copyStereo({ source: packet, target: window.buffer, from, to, offset: packetStart + from - firstSample });
}

export function sliceAudioWindow(source: AudioBuffer, start: number, end: number): DecodedAudioWindow {
	const window = createWindow(start, end, source.sampleRate);
	copyPacket(window, source, 0);
	return window;
}

/** Assemble only the requested window. The buffer origin stays on the native sample grid. */
export async function decodeAudioWindow({
	input, start, end, signal, requiresAudio = true,
}: {
	input: Input;
	start: number;
	end: number;
	signal?: AbortSignal;
	requiresAudio?: boolean;
}): Promise<DecodedAudioWindow | null> {
	signal?.throwIfAborted();
	const dispose = () => input.dispose();
	signal?.addEventListener("abort", dispose, { once: true });
	let packets: AsyncGenerator<WrappedAudioBuffer, void, unknown> | undefined;
	try {
		const track = await waitWithAbort(input.getPrimaryAudioTrack(), signal);
		if (!track) {
			if (requiresAudio) throw new Error("No audio track found");
			return null;
		}

		// Keep the pre-roll needed by a packet that straddles the first sample.
		const seek = Math.max(0, start - 1 / 8000);
		if (end <= 0) return createWindow(start, end, track.sampleRate);
		packets = new AudioBufferSink(track).buffers(seek, end);
		let window: DecodedAudioWindow | undefined;
		let deadline = performance.now() + 8;
		while (true) {
			signal?.throwIfAborted();
			const result = await waitWithAbort(packets.next(), signal);
			if (result.done) break;
			const { buffer: packet, timestamp } = result.value;
			window ??= createWindow(start, end, packet.sampleRate);
			copyPacket(window, packet, timestamp);
			if (performance.now() >= deadline) {
				await yieldAudioTask(signal);
				deadline = performance.now() + 8;
			}
		}
		return window ?? createWindow(start, end, track.sampleRate);
	} finally {
		signal?.removeEventListener("abort", dispose);
		// An aborted iterator can still be unwinding its pending next(). The
		// owning input has already been disposed in that case.
		if (signal?.aborted) void packets?.return().catch(() => {});
		else await packets?.return();
	}
}
