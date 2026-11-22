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

/** Check the real packet bytes, since a truncated file can still advertise its full duration. */
export async function checkLastPacket(track: InputTrack): Promise<void> {
	const packet = await new EncodedPacketSink(track).getPacket(Infinity);
	if (!packet?.data.length || packet.data.length !== packet.byteLength) {
		throw new Error("The track has missing packet data");
	}
}

export async function withFirstVideoFrame<T>(
	track: InputVideoTrack,
	signal: AbortSignal | undefined,
	use: (frame: VideoSample) => T,
): Promise<T> {
	const timestamp = await track.getFirstTimestamp();
	signal?.throwIfAborted();
	// getSample closes its iterator. This continuation also owns a frame that arrives after abort.
	const frame = await new VideoSampleSink(track).getSample(timestamp);
	try {
		signal?.throwIfAborted();
		if (!frame) throw new Error("No video frames could be decoded");
		return use(frame);
	} finally {
		frame?.close();
	}
}

export function verifyVideoFile(file: File, signal: AbortSignal): Promise<void> {
	return withVideoInput(file, signal, async (input) => {
		const track = await getDecodableVideoTrack(input);
		signal.throwIfAborted();
		await checkLastPacket(track);
		await withFirstVideoFrame(track, signal, () => {});
	});
}
