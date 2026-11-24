import { expect, spyOn, test } from "bun:test";
import { InputVideoTrack, VideoSampleSink } from "mediabunny";
import { retiringSamples } from "./retiring-sink";

test("a cancelled sample stream retains its retirement slot until the opening decoder is closed", async () => {
	let closed = 0;
	const decoder = {
		decode() {},
		async flush() {},
		close() { closed++; },
		getDecodeQueueSize: () => 0,
	};
	type OpeningSink = { _createDecoder: () => Promise<typeof decoder> };
	const opened = Promise.withResolvers<typeof decoder>();
	const create = spyOn(VideoSampleSink.prototype as unknown as OpeningSink, "_createDecoder")
		.mockReturnValue(opened.promise);
	const track: InputVideoTrack = Object.create(InputVideoTrack.prototype);
	try {
		const samples = retiringSamples(track, (sink) => {
			void (sink as unknown as OpeningSink)._createDecoder();
			return (async function* () { yield null; })();
		});
		let retired = false;
		const retirement = samples.return().then(() => { retired = true; });
		await Promise.resolve();
		expect(retired).toBe(false);
		opened.resolve(decoder);
		await retirement;
		expect(closed).toBe(1);
		await samples.return();
		expect(closed).toBe(1);
	} finally {
		create.mockRestore();
	}
});
