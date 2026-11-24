import { expect, test } from "bun:test";
import { createScrubSettle } from "./scrub-settle";

function fixture() {
	let time = 0;
	let timer: { due: number; run: () => void } | undefined;
	const starts: number[] = [];
	const results: number[] = [];
	const discarded: number[] = [];
	let pending: PromiseWithResolvers<number | null>;
	const settle = createScrubSettle({
		now: () => time,
		after(delay, run) {
			timer = { due: time + delay, run };
			return () => { timer = undefined; };
		},
		prepare(_scene: string, frame) {
			starts.push(frame);
			pending = Promise.withResolvers<number | null>();
			return pending.promise;
		},
		discard: frame => discarded.push(frame),
		onResult: () => results.push(time),
	});
	return {
		settle, starts, results, discarded,
		advance(elapsed: number) {
			time += elapsed;
			if (timer && timer.due <= time) {
				const { run } = timer;
				timer = undefined;
				run();
			}
		},
		finish: async (frame: number) => { pending.resolve(frame); await pending.promise; await Promise.resolve(); },
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

test("moving again leaves the previous decode running and ignores its pixels", async () => {
	const { settle, advance, starts, finish, discarded, results } = fixture();
	settle.update("scene", 1, true);
	advance(150);
	settle.update("scene", 2, true);
	advance(200);
	expect(starts).toEqual([1]);
	expect(settle.isPending("scene", 2)).toBe(false);
	await finish(1);
	expect(discarded).toEqual([1]);
	expect(results).toEqual([]);
	advance(0);
	expect(starts).toEqual([1, 2]);
	await finish(2);
	expect(settle.take("scene", 2)).toBe(2);
});
