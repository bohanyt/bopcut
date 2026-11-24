import { expect, test } from "bun:test";
import { WaveformCache } from "./service";

test("a new project can build a waveform while a previous project's decode is still pending", async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "window");
	const started = Promise.withResolvers<void>();
	const decode = Promise.withResolvers<AudioBuffer>();
	const buffer = { length: 0, numberOfChannels: 1, sampleRate: 48_000 } as AudioBuffer;
	class SlowAudioContext {
		decodeAudioData() {
			started.resolve();
			return decode.promise;
		}
		async close() {}
	}
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { AudioContext: SlowAudioContext },
	});
	const cache = new WaveformCache();
	const old = cache.getSourceSummary({ sourceKey: "old", sourceFile: new File(["old"], "old.wav") })
		.catch((error: unknown) => error);
	try {
		await started.promise;
		cache.clearAll();
		const summary = await cache.getSourceSummary({ sourceKey: "new", audioBuffer: buffer });
		expect(summary.sourceKey).toBe("new");
		decode.resolve(buffer);
		expect(await old).toBeInstanceOf(DOMException);
		expect(await cache.getSourceSummary({ sourceKey: "new", audioBuffer: buffer })).toBe(summary);
	} finally {
		decode.resolve(buffer);
		if (original) Object.defineProperty(globalThis, "window", original);
		else Reflect.deleteProperty(globalThis, "window");
	}
}, 1000);
