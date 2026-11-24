import { expect, test } from "bun:test";
import { createPreviewFrameScheduler } from "./frame-scheduler";

test("a paused recoverable failure retries once per invalidation", async () => {
	const clock = frameClock();
	const error = new Error("temporary surface failure");
	const failed = Promise.reject(error);
	void failed.catch(() => {});
	let renders = 0;
	const options = {
		...clock,
		render: () => { renders++; return failed; },
		shouldRetry: (failure: unknown) => failure === error,
	};
	const scheduler = createPreviewFrameScheduler(options);
	scheduler.request();
	clock.tick();
	await Promise.resolve();
	expect(clock.pending()).toBe(1);
	clock.tick();
	await Promise.resolve();
	expect(renders).toBe(2);
	expect(clock.pending()).toBe(0);
	scheduler.request();
	clock.tick();
	await Promise.resolve();
	expect(renders).toBe(3);
	expect(clock.pending()).toBe(1);
});

function frameClock() {
	const pending = new Map<number, () => void>();
	let id = 0;
	return {
		requestFrame: (callback: () => void) => {
			pending.set(++id, callback);
			return id;
		},
		cancelFrame: (id: number) => { pending.delete(id); },
		pending: () => pending.size,
		tick: () => {
			const callbacks = [...pending.values()];
			pending.clear();
			for (const callback of callbacks) callback();
		},
	};
}

test("paused invalidations coalesce and the frame clock goes idle", () => {
	const clock = frameClock();
	let renders = 0;
	const scheduler = createPreviewFrameScheduler({
		...clock,
		render: () => { renders++; },
	});
	expect(clock.pending()).toBe(0);
	scheduler.request();
	scheduler.request();
	expect(clock.pending()).toBe(1);
	clock.tick();
	expect(renders).toBe(1);
	expect(clock.pending()).toBe(0);
	scheduler.playbackTick();
	expect(renders).toBe(2);
	expect(clock.pending()).toBe(0);
});

test("updates during a render schedule one follow-up, and disposal prevents late work", async () => {
	const clock = frameClock();
	const draw = Promise.withResolvers<void>();
	let renders = 0;
	const scheduler = createPreviewFrameScheduler({
		...clock,
		render: () => {
			renders++;
			return renders === 1 ? draw.promise : undefined;
		},
	});
	scheduler.playbackTick();
	scheduler.playbackTick();
	scheduler.request();
	expect(renders).toBe(1);
	expect(clock.pending()).toBe(0);
	draw.resolve();
	await draw.promise;
	expect(clock.pending()).toBe(1);
	clock.tick();
	expect(renders).toBe(2);
	scheduler.request();
	scheduler.dispose();
	clock.tick();
	expect(renders).toBe(2);
	expect(clock.pending()).toBe(0);
});

test("a burst cancels the old exact seek and settles at the same time on release", async () => {
	const clock = frameClock();
	const renders: { signal: AbortSignal; approximate: boolean }[] = [];
	const exact = Promise.withResolvers<void>();
	let now = 0;
	const scheduler = createPreviewFrameScheduler({
		...clock,
		now: () => now,
		render(options) {
			renders.push(options);
			return renders.length === 1 ? exact.promise : undefined;
		},
	});
	scheduler.seek(12, false, false);
	clock.tick();
	now = 16;
	scheduler.seek(12, false, false);
	expect(renders[0].signal.aborted).toBe(true);
	exact.resolve();
	await exact.promise;
	clock.tick();
	expect(renders.map(({ approximate }) => approximate)).toEqual([false, true]);
	scheduler.settle();
	clock.tick();
	expect(renders.map(({ approximate }) => approximate)).toEqual([false, true, false]);
	scheduler.scrubFrameReady();
	expect(clock.pending()).toBe(0);
	scheduler.dispose();
});

test("holding the pointer still requests an exact render during a drag", () => {
	const clock = frameClock();
	let fire: (() => void) | undefined;
	const modes: boolean[] = [];
	const scheduler = createPreviewFrameScheduler({
		...clock,
		setTimer(callback) { fire = callback; return 1 as unknown as ReturnType<typeof setTimeout>; },
		clearTimer() { fire = undefined; },
		render({ approximate }) { modes.push(approximate); },
	});
	scheduler.seek(12, true, false);
	clock.tick();
	fire?.();
	clock.tick();
	expect(modes).toEqual([true, false]);
	scheduler.dispose();
});
