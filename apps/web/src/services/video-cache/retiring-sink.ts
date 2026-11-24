import { VideoSampleSink, type EncodedPacket, type InputVideoTrack, type VideoSample } from "mediabunny";

type Decoder = {
	decode(packet: EncodedPacket): void;
	flush(): Promise<void>;
	close(): void;
	getDecodeQueueSize(): number;
};

type CreateDecoder = (
	onSample: (sample: VideoSample) => unknown,
	onError: (error: Error) => unknown,
) => Promise<Decoder>;

/**
 * A Mediabunny iterator returns before its decoder closes. Own its decoder while
 * retaining the sink's packet ordering, pixel conversion, and codec handling.
 */
export function retiringSamples<Sample extends VideoSample | null>(
	track: InputVideoTrack,
	open: (sink: VideoSampleSink) => AsyncGenerator<Sample, void, unknown>,
): AsyncGenerator<Sample, void, unknown> {
	const sink = new VideoSampleSink(track) as VideoSampleSink & { _createDecoder?: CreateDecoder };
	const createDecoder = sink._createDecoder?.bind(sink);
	let opening: Promise<Decoder> | undefined;
	let decoder: Decoder | undefined;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		decoder?.close();
		decoder = undefined;
	};
	if (createDecoder) {
		// This instance-only hook matches the decoder interface in the locked library version.
		sink._createDecoder = (onSample, onError) => {
			opening = createDecoder(onSample, onError);
			return opening.then((created) => {
				if (closed) created.close();
				else decoder = created;
				return {
					decode: (packet) => { decoder?.decode(packet); },
					flush: async () => { await decoder?.flush(); },
					close,
					getDecodeQueueSize: () => decoder?.getDecodeQueueSize() ?? 0,
				};
			});
		};
	}
	const iterator = open(sink);
	const shutdown = async () => {
		close();
		try {
			return await iterator.return();
		} finally {
			await opening?.catch(() => {});
		}
	};
	let retired: ReturnType<typeof shutdown> | undefined;
	const retire = () => retired ??= shutdown();
	const result: typeof iterator = {
		next: async () => {
			try {
				return await iterator.next();
			} catch (error) {
				await retire();
				throw error;
			}
		},
		return: retire,
		throw: async (error: unknown) => {
			await retire();
			throw error;
		},
		[Symbol.asyncIterator]: () => result,
		[Symbol.asyncDispose]: async () => { await retire(); },
	};
	return result;
}
