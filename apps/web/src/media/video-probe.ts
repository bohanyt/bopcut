import {
	ALL_FORMATS,
	BlobSource,
	EncodedPacketSink,
	Input,
	VideoSampleSink,
	type InputTrack,
	type InputVideoTrack,
	type VideoSample,
} from "mediabunny";
import { waitWithAbort } from "@/utils/abort";

export async function withVideoInput<T>(
	file: File,
	signal: AbortSignal | undefined,
	read: (input: Input) => Promise<T>,
): Promise<T> {
	signal?.throwIfAborted();
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		return await waitWithAbort(read(input), signal);
	} finally {
		input.dispose();
	}
}

export async function getDecodableVideoTrack(input: Input): Promise<InputVideoTrack> {
	const track = await input.getPrimaryVideoTrack();
	if (!track) throw new Error("No video track found in the file");
	if (!await track.canDecode()) {
		const codec = track.codec ?? track.internalCodecId;
		const label = codec == null ? "The video codec" : String(codec).toUpperCase();
		const advice = codec === "hevc" ? " or try importing it in Safari" : "";
		throw new Error(`${label} cannot be decoded in this browser. Convert it to H.264 MP4${advice}.`);
	}
	return track;
}

/** Read the end of the encoded stream, including reordered packets after the last presentation timestamp. */
export async function checkPacketTail(track: InputTrack, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const sink = new EncodedPacketSink(track);
	let packet = await sink.getPacket(Infinity);
	if (!packet) throw new Error("The track has missing packet data");
	while (packet) {
		signal?.throwIfAborted();
		if (!packet.data.length || packet.data.length !== packet.byteLength) {
			throw new Error("The track has missing packet data");
		}
		packet = await sink.getNextPacket(packet);
	}
}

export async function withFirstSample<Sample extends { close(): void }, Result>(
	samples: AsyncGenerator<Sample, void, unknown>,
	signal: AbortSignal | undefined,
	use: (sample: Sample | null) => Result,
): Promise<Result> {
	try {
		const first = samples.next().then(({ value }) => {
			try {
				signal?.throwIfAborted();
				return use(value ?? null);
			} finally {
				value?.close();
			}
		});
		return await waitWithAbort(first, signal);
	} finally {
		await samples.return();
	}
}

export async function withFirstVideoFrame<T>(
	track: InputVideoTrack,
	signal: AbortSignal | undefined,
	use: (frame: VideoSample) => T,
): Promise<T> {
	const timestamp = await track.getFirstTimestamp();
	signal?.throwIfAborted();
	return withFirstSample(new VideoSampleSink(track).samples(timestamp), signal, (frame) => {
		if (!frame) throw new Error("No video frames could be decoded");
		return use(frame);
	});
}

export function verifyVideoFile(file: File, signal: AbortSignal): Promise<void> {
	return withVideoInput(file, signal, async (input) => {
		const track = await getDecodableVideoTrack(input);
		await checkPacketTail(track, signal);
		await withFirstVideoFrame(track, signal, () => {});
	});
}
