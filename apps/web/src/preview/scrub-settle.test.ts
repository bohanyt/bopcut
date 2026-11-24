import { expect, test } from "bun:test";
import { createScrubSettle } from "./scrub-settle";

function fixture() {
	let time = 0;
	let timer: { due: number; run: () => void } | undefined;
	const starts: number[] = [];
	const results: number[] = [];
	const discarded: number[] = [];
	const pending = new Map<number, PromiseWithResolvers<number | null>>();
	const signals = new Map<number, AbortSignal>();
	const settle = createScrubSettle({
		now: () => time,
		after(delay, run) {
			timer = { due: time + delay, run };
			return () => { timer = undefined; };
		},
		prepare(_scene: string, frame, signal) {
			starts.push(frame);
			signals.set(frame, signal);
			const decode = Promise.withResolvers<number | null>();
			pending.set(frame, decode);
			return decode.promise;
		},
		discard: frame => discarded.push(frame),
		onResult: () => results.push(time),
	});
	return {
		settle, starts, results, discarded, signals,
		advance(elapsed: number) {
			time += elapsed;
			if (timer && timer.due <= time) {
				const { run } = timer;
				timer = undefined;
				run();
			}
		},
		async finish(frame: number) {
			const decode = pending.get(frame)!;
			decode.resolve(frame);
			await decode.promise;
			await Promise.resolve();
		},
	};
}

test("100 ms seeks and paused navigation never start a settle decode", () => {
	const { settle, advance, starts } = fixture();
	for (let frame = 0; frame < 10; frame++) {
		settle.update("scene", frame, true);
		advance(100);
	}
	settle.update("scene", 9, false);
	advance(500);
	settle.update("scene", 10, false);
	advance(500);
	expect(starts).toEqual([]);
});

test("starts at 150 ms and hands the same decode through release", async () => {
	const { settle, advance, starts, finish, results } = fixture();
	settle.update("scene", 1, true);
	advance(149);
	expect(starts).toEqual([]);
	advance(1);
	expect(starts).toEqual([1]);
	settle.update("scene", 1, false);
	expect(settle.isPending("scene", 1)).toBe(true);
	await finish(1);
	expect(results).toHaveLength(1);
	expect(settle.take("scene", 1)).toBe(1);
	expect(settle.isPrepared("scene", 1)).toBe(true);
});

test("a new seek aborts a hung decode and discards any late frames", async () => {
	const { settle, advance, starts, finish, discarded, results, signals } = fixture();
	settle.update("scene", 1, true);
	advance(150);
	settle.update("scene", 2, true);
	expect(signals.get(1)?.aborted).toBe(true);
	advance(149);
	expect(starts).toEqual([1]);
	expect(settle.isPending("scene", 2)).toBe(false);
	advance(1);
	expect(starts).toEqual([1, 2]);
	await finish(1);
	expect(discarded).toEqual([1]);
	expect(results).toEqual([]);
	await finish(2);
	expect(settle.take("scene", 2)).toBe(2);
});

test("release on the same target waits at most one second for a hung decode", () => {
	const { settle, advance, signals, results } = fixture();
	settle.update("scene", 1, true);
	advance(150);
	settle.update("scene", 1, false);
	advance(999);
	settle.update("scene", 1, false);
	expect(settle.isPending("scene", 1)).toBe(true);
	advance(1);
	expect(signals.get(1)?.aborted).toBe(true);
	expect(settle.isPending("scene", 1)).toBe(false);
	expect(results).toHaveLength(1);
});

test("release at another time aborts immediately, as do hide, project close and unmount", () => {
	const { settle, advance, signals, results } = fixture();
	settle.update("scene", 1, true);
	advance(150);
	settle.update("scene", 2, false);
	expect(signals.get(1)?.aborted).toBe(true);
	expect(settle.isPending("scene", 2)).toBe(false);
	settle.update("scene", 3, true);
	advance(150);
	settle.reset(); // The preview resets on hide and when its project or component is disposed.
	expect(signals.get(3)?.aborted).toBe(true);
	settle.update("scene", 4, true);
	advance(150);
	settle.update("scene", 4, false);
	settle.reset();
	advance(1000);
	expect(signals.get(4)?.aborted).toBe(true);
	expect(results).toEqual([]);
});
