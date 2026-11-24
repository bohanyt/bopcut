import { expect, test } from "bun:test";
import { WaveformCache } from "./service";

test("a pending library download leaves the decode queue available", async () => {
	const original = globalThis.fetch;
	const started = Promise.withResolvers<void>();
	const download = Promise.withResolvers<Response>();
	const buffer = { length: 0, numberOfChannels: 1, sampleRate: 48_000 } as AudioBuffer;
	globalThis.fetch = Object.assign(() => {
		started.resolve();
		return download.promise;
	}, { preconnect: original.preconnect });
	const cache = new WaveformCache();
	const remote = cache.getSourceSummary({ sourceKey: "remote", audioUrl: "https://example.test/sound" })
		.catch((error: unknown) => error);
	try {
		await started.promise;
		const ready = await cache.getSourceSummary({ sourceKey: "ready", audioBuffer: buffer });
		expect(ready.sourceKey).toBe("ready");
	} finally {
		cache.clearAll();
		download.resolve(new Response(null, { status: 404 }));
		globalThis.fetch = original;
		await remote;
	}
}, 1000);

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
