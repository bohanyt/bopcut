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
});
