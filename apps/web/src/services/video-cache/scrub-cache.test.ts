import { expect, spyOn, test } from "bun:test";
import { EncodedPacket, EncodedPacketSink, Input, InputVideoTrack, VideoSample, VideoSampleSink } from "mediabunny";
import { ScrubVideoCache } from "./scrub-cache";

const keyPacket = (time: number) => new EncodedPacket(Uint8Array.of(1), "key", time, 1);

async function withCache(run: (fixture: {
	cache: ScrubVideoCache;
	disposed: () => number;
	reads: number[];
	closed: number[];
	elapse: (ms: number) => void;
	decode: (read: (time: number) => Promise<VideoSample | null>, cancel: () => void) => void;
	sample: (time: number) => VideoSample;
}) => Promise<void>) {
	const oldCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		value: class {
			constructor(public width: number, public height: number) {}
			getContext() { return {}; }
		},
	});
	const track: InputVideoTrack = Object.create(InputVideoTrack.prototype, {
		displayWidth: { value: 1920 },
		displayHeight: { value: 1080 },
		rotation: { value: 90 },
		canDecode: { value: async () => true },
	});
	const reads: number[] = [];
	const closed: number[] = [];
	const sample = (time: number): VideoSample => Object.create(VideoSample.prototype, {
		timestamp: { value: time },
		drawWithFit: { value: (_canvas: unknown, options: object) => expect(options).toEqual({ fit: "fill", rotation: 90 }) },
		close: { value: () => closed.push(time) },
	});
	let read = async (time: number): Promise<VideoSample | null> => sample(time);
	let cancel = () => {};
	const dispose = spyOn(Input.prototype, "dispose");
	const spies = [
		dispose,
		spyOn(Input.prototype, "getPrimaryVideoTrack").mockResolvedValue(track),
		spyOn(EncodedPacketSink.prototype, "getKeyPacket").mockImplementation(async (time) => keyPacket(Math.floor(time / 2) * 2)),
		spyOn(EncodedPacketSink.prototype, "getNextKeyPacket").mockImplementation(async (packet) => keyPacket(packet.timestamp + 2)),
		spyOn(VideoSampleSink.prototype, "samplesAtTimestamps").mockImplementation((timestamps) => {
			const points = Array.from(timestamps as Iterable<number>);
			reads.push(points[0]);
			let i = 0;
			const iterator: ReturnType<VideoSampleSink["samplesAtTimestamps"]> = {
				next: async () => ({ done: false, value: await read(points[i++]) }),
				return: async () => {
					cancel();
					return { done: true, value: undefined };
				},
				throw: async (error: unknown) => { throw error; },
				[Symbol.asyncIterator]: () => iterator,
				[Symbol.asyncDispose]: async () => { await iterator.return(); },
			};
			return iterator;
		}),
	];
	let elapsed = 0;
	const cache = new ScrubVideoCache(() => elapsed);
	try {
		await run({
			cache, reads, closed, sample,
			elapse: (ms) => { elapsed += ms; },
			disposed: () => dispose.mock.calls.length,
			decode: (next, close) => { read = next; cancel = close; },
		});
	} finally {
		cache.clear();
		for (const spy of spies) spy.mockRestore();
		if (oldCanvas) Object.defineProperty(globalThis, "OffscreenCanvas", oldCanvas);
		else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
	}
}

async function load(cache: ScrubVideoCache, file: File, time: number) {
	const ready = Promise.withResolvers<void>();
	cache.getFrameAt(file, time);
	cache.finishFrame(ready.resolve);
	await ready.promise;
	return cache.getFrameAt(file, time);
}

test("scrub frames are scoped to the file and keyframe interval", () =>
	withCache(async ({ cache, reads, closed }) => {
		const first = new File([], "same-name.mp4");
		const second = new File([], "same-name.mp4");
		const frame = await load(cache, first, 1);
		expect(frame?.canvas).toMatchObject({ width: 640, height: 360 });
		expect(cache.getFrameAt(first, 1.9)).toBe(frame);
		expect(cache.getFrameAt(first, 2)).toBeNull();
		expect(cache.getFrameAt(second, 1)).toBeNull();
		cache.finishFrame();
		expect(reads).toEqual([0]);
		expect(closed).toEqual([0]);
	}));

test("scrub source and frame eviction dispose resources and keep recent frames", () =>
	withCache(async ({ cache, disposed }) => {
		const first = new File([], "first.mp4");
		const canvas = (await load(cache, first, 0))!.canvas;
		for (let i = 1; i < 12; i++) await load(cache, first, i * 2);
		expect(canvas.width).toBe(0);
		const lastCanvas = cache.getFrameAt(first, 22)!.canvas;
		for (let i = 0; i < 6; i++) await load(cache, new File([], `${i}.mp4`), 0);
		expect(disposed()).toBe(1);
		expect(lastCanvas.width).toBe(0);
		cache.clear();
		expect(disposed()).toBe(7);
	}));

test("a superseded keyframe decode is returned and its late sample is closed", () =>
	withCache(async ({ cache, closed, decode, sample }) => {
		const first = new File([], "first.mp4");
		const second = new File([], "second.mp4");
		const started = Promise.withResolvers<void>();
		const stale = Promise.withResolvers<VideoSample>();
		const cancelled = Promise.withResolvers<void>();
		decode(async (time) => {
			if (time !== 0) return sample(time);
			started.resolve();
			return stale.promise;
		}, cancelled.resolve);
		const oldReady = () => { throw new Error("Superseded decode published a frame"); };
		expect(cache.getFrameAt(first, 1)).toBeNull();
		cache.finishFrame(oldReady);
		await started.promise;
		const current = await load(cache, second, 3);
		await cancelled.promise;
		stale.resolve(sample(0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(closed).toEqual([2, 0]);
		expect(current?.timestamp).toBe(2);
		expect(cache.getFrameAt(first, 1)).toBeNull();
	}));

test("source eviction honors the byte budget even below the source count limit", () =>
	withCache(async ({ cache, disposed }) => {
		const files = Array.from({ length: 4 }, (_, i) => {
			const file = new File([], `large-${i}.mp4`);
			Object.defineProperty(file, "size", { value: 10 * 1024 * 1024 });
			return file;
		});
		const oldest = (await load(cache, files[0], 0))!;
		for (const file of files.slice(1)) await load(cache, file, 0);
		expect(disposed()).toBe(1);
		expect(oldest.canvas.width).toBe(0);
	}));

test("overlapping sources share the bounded decoder pool", () =>
	withCache(async ({ cache, reads, decode, sample }) => {
		const enough = Promise.withResolvers<void>();
		const unblock = Promise.withResolvers<void>();
		const ready = Promise.withResolvers<void>();
		let active = 0;
		let peak = 0;
		decode(async (time) => {
			peak = Math.max(peak, ++active);
			if (active === 2) enough.resolve();
			await unblock.promise;
			return sample(time);
		}, () => { active--; });
		const files = Array.from({ length: 5 }, (_, i) => new File([], `layer-${i}.mp4`));
		for (const file of files) expect(cache.getFrameAt(file, 0)).toBeNull();
		let completed = 0;
		cache.finishFrame(() => { if (++completed === files.length) ready.resolve(); });
		await enough.promise;
		expect(reads).toHaveLength(2);
		unblock.resolve();
		await ready.promise;
		expect(peak).toBe(2);
		expect(files.every((file) => cache.getFrameAt(file, 0))).toBe(true);
	}));

test("a sustained scrub switches from the keyframe to nearby decoded frames", () =>
	withCache(async ({ cache, reads, elapse }) => {
		const file = new File([], "source.mp4");
		const fallback = await load(cache, file, 1.02);
		expect(fallback?.timestamp).toBe(0);
		cache.finishFrame(() => {});
		expect(reads).toEqual([0]);
		elapse(160);
		const ready = Promise.withResolvers<void>();
		expect(cache.getFrameAt(file, 1.02)).toBe(fallback);
		cache.finishFrame(ready.resolve);
		await ready.promise;
		const detail = cache.getFrameAt(file, 1.02);
		expect(detail?.timestamp).toBe(1);
		expect(detail?.canvas.width).toBe(320);
		expect(cache.getFrameAt(file, 0.51)?.timestamp).toBe(0.5);
		expect(cache.getFrameAt(file, 2)).toBeNull();
		cache.stop();
	}));
