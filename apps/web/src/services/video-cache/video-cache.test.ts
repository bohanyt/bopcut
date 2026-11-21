import { describe, expect, test } from "bun:test";
import { VideoCache } from "./service";

/** A cache whose decoder is fake: resolving a time takes a moment and makes that frame current. */
function fakeCache() {
	const cache = new VideoCache();
	const decoded: number[] = [];
	const sink = { currentFrame: null as { timestamp: number } | null };
	Object.assign(cache as object, {
		ensureSink: async ({ mediaId }: { mediaId: string }) => {
			(cache as unknown as { sinks: Map<string, unknown> }).sinks.set(mediaId, sink);
		},
		resolveFrame: async ({ time }: { time: number }) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			decoded.push(time);
			sink.currentFrame = { timestamp: time };
			return sink.currentFrame;
		},
	});
	return { cache, decoded };
}

const file = new File(["x"], "clip.mp4");
const at = (frame: unknown) => (frame as { timestamp: number } | null)?.timestamp;

describe("video frames", () => {
	test("a preview request overtaken by a newer one gets the current frame (scrubbing stays fast)", async () => {
		const { cache, decoded } = fakeCache();
		const [first, second, third] = await Promise.all([
			cache.getFrameAt({ mediaId: "m", file, time: 1 }),
			cache.getFrameAt({ mediaId: "m", file, time: 2 }),
			cache.getFrameAt({ mediaId: "m", file, time: 3 }),
		]);
		// Only the newest time is decoded; the overtaken ones get whatever frame is current.
		expect(decoded).toEqual([3]);
		expect(at(third)).toBe(3);
		expect([first, second]).toEqual([null, null]);
	});

	test("an exact request gets its own frame even while the preview keeps asking for another time", async () => {
		// Before: the snapshot was overtaken by the preview's next request and got the preview's frame.
		const before = fakeCache();
		await before.cache.getFrameAt({ mediaId: "m", file, time: 0 });
		const overtaken = before.cache.getFrameAt({ mediaId: "m", file, time: 2.8 });
		await before.cache.getFrameAt({ mediaId: "m", file, time: 0 });
		expect(at(await overtaken)).toBe(0);

		const { cache, decoded } = fakeCache();
		await cache.getFrameAt({ mediaId: "m", file, time: 0 });
		const snapshot = cache.getFrameAt({ mediaId: "m", file, time: 2.8, exact: true });
		const previewAgain = cache.getFrameAt({ mediaId: "m", file, time: 0 });
		expect(at(await snapshot)).toBe(2.8);
		expect(at(await previewAgain)).toBe(0);
		expect(decoded).toEqual([0, 2.8, 0]);
	});

	test("several exact requests in a row each decode their own time", async () => {
		const { cache } = fakeCache();
		const frames = await Promise.all([0.15, 1.2, 2.8].map((time) => cache.getFrameAt({ mediaId: "m", file, time, exact: true })));
		expect(frames.map(at)).toEqual([0.15, 1.2, 2.8]);
	});

	test("a same-clip preview completes before an abandoned export decode settles", async () => {
		const cache = new VideoCache();
		const sinks = (cache as unknown as { sinks: Map<string, unknown> }).sinks;
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const disposed: number[] = [];
		let sinkCount = 0;
		Object.assign(cache, {
			ensureSink: async ({ mediaId }: { mediaId: string }) => {
				if (sinks.has(mediaId)) return;
				const sinkNumber = ++sinkCount;
				sinks.set(mediaId, {
					file,
					input: {
						disposed: false,
						dispose() {
							this.disposed = true;
							disposed.push(sinkNumber);
						},
					},
					sink: {
						async *canvases(time: number) {
							try {
								if (sinkNumber === 1) {
									started.resolve();
									await release.promise;
								}
								yield { timestamp: time, duration: 0.5 };
							} finally {
								if (sinkNumber === 1) closed.resolve();
							}
						},
					},
				});
			},
		});

		const controller = new AbortController();
		const abandoned = cache.getFrameAt({
			mediaId: "m", file, time: 1, exact: true, signal: controller.signal,
		}).catch((error: unknown) => error);
		try {
			await started.promise;
			controller.abort();
			const preview = () => cache.getFrameAt({ mediaId: "m", file, time: 2 });
			const frame = await Promise.race([preview(), Bun.sleep(0).then(() => null)]);
			expect(at(frame)).toBe(2);
			expect(await abandoned).toBe(controller.signal.reason);

			release.resolve();
			await closed.promise;
			expect(await preview()).toBe(frame);
			expect(disposed).toEqual([1]);
		} finally {
			release.resolve();
			cache.clearAll();
		}
	});

	test("export reads report seek errors and tracks that decode no frames", async () => {
		const cache = new VideoCache();
		const sinks = (cache as unknown as { sinks: Map<string, unknown> }).sinks;
		const input = { disposed: false };
		sinks.set("m", {
			file,
			input,
			sink: { async *canvases() { throw new Error("Invalid packet"); } },
		});
		const read = () => cache.getFrameAt({ mediaId: "m", file, time: 0, exact: true, throwOnSeekError: true });
		await expect(read()).rejects.toThrow("Invalid packet");
		sinks.set("m", { file, input, sink: { async *canvases() {} } });
		await expect(read()).rejects.toThrow("No video frames could be decoded");
	});
});
