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

test("an explicit drag cancels the old exact seek and settles at the same time on release", async () => {
	const clock = frameClock();
	const renders: { signal: AbortSignal; approximate: boolean }[] = [];
	const exact = Promise.withResolvers<void>();
	const scheduler = createPreviewFrameScheduler({
		...clock,
		render(options) {
			renders.push(options);
			return renders.length === 1 ? exact.promise : undefined;
		},
	});
	scheduler.seek(12, false, false);
	clock.tick();
	scheduler.seek(12, true, false);
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

test("keyboard steps and seeks during playback use exact rendering", () => {
	const clock = frameClock();
	const modes: boolean[] = [];
	const scheduler = createPreviewFrameScheduler({
		...clock,
		render({ approximate }) { modes.push(approximate); },
	});
	scheduler.seek(1, false, false);
	clock.tick();
	scheduler.seek(2, false, false);
	clock.tick();
	scheduler.seek(3, true, true);
	clock.tick();
	expect(modes).toEqual([false, false, false]);
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

test("a continuously held preview falls back to exact without restarting its deadline", () => {
	const clock = frameClock();
	const timers = new Map<number, () => void>();
	const modes: boolean[] = [];
	const scheduler = createPreviewFrameScheduler({
		...clock,
		setTimer(callback, delay) {
			timers.set(delay, callback);
			return delay as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer(id) { timers.delete(Number(id)); },
		render({ approximate }) { modes.push(approximate); },
	});
	scheduler.seek(12, true, false);
	const deadline = timers.get(250);
	expect(deadline).toBeDefined();
	clock.tick();
	scheduler.scrubFrameBlocked();
	scheduler.seek(13, true, false);
	clock.tick();
	scheduler.scrubFrameBlocked();
	expect(timers.get(250)).toBe(deadline);
	deadline?.();
	clock.tick();
	expect(modes).toEqual([true, true, false]);
	scheduler.dispose();
});

test("retained redraws during random back-and-forth jumps share one 250 ms deadline", () => {
	for (let seed = 1; seed <= 8; seed++) {
		const clock = frameClock();
		let now = 0;
		let picture = 5.07;
		let target = picture;
		let staleSince: number | undefined;
		let recovered = 0;
		let random = seed;
		const timers = new Map<number, { at: number; run: () => void }>();
		let timerId = 0;
		const scheduler = createPreviewFrameScheduler({
			...clock,
			setTimer(run, delay) {
				timers.set(++timerId, { at: now + delay, run });
				return timerId as unknown as ReturnType<typeof setTimeout>;
			},
			clearTimer(id) { timers.delete(Number(id)); },
			render({ approximate }) {
				if (approximate && picture !== target) {
					staleSince ??= now;
					scheduler.scrubFramePresented(true);
				} else {
					if (!approximate && staleSince !== undefined) {
						expect(now - staleSince).toBeLessThanOrEqual(250);
						recovered++;
						scheduler.scrubRecoveryFinished();
					}
					staleSince = undefined;
					picture = target;
					scheduler.scrubFramePresented();
				}
			},
		});
		for (now = 0; now <= 2_000; now += 5) {
			for (const [id, timer] of timers) {
				if (timer.at > now) continue;
				timers.delete(id);
				timer.run();
			}
			if (now % 20 === 0) {
				random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
				target = (random % 1000) / 100 + now / 100_000;
				scheduler.seek(target, true, false);
			} else scheduler.scrubFrameReady();
			clock.tick();
			if (staleSince !== undefined) expect(now - staleSince).toBeLessThan(250);
		}
		expect(recovered).toBeGreaterThan(4);
		scheduler.dispose();
	}
});

test("failed recovery resumes approximation and waits another hold interval", () => {
	const clock = frameClock();
	const timers = new Map<number, () => void>();
	const recoveries: boolean[] = [];
	const scheduler = createPreviewFrameScheduler({
		...clock,
		setTimer(run, delay) {
			timers.set(delay, run);
			return delay as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer(id) { timers.delete(Number(id)); },
		render({ recovering }) { recoveries.push(recovering); },
	});
	scheduler.seek(1, true, false);
	clock.tick();
	const first = timers.get(250);
	first?.();
	clock.tick();
	scheduler.scrubRecoveryFinished();
	const second = timers.get(250);
	expect(second).toBeDefined();
	expect(second).not.toBe(first);
	scheduler.seek(2, true, false);
	clock.tick();
	expect(recoveries).toEqual([false, true, false]);
	expect(timers.get(250)).toBe(second);
	second?.();
	clock.tick();
	expect(recoveries).toEqual([false, true, false, true]);
	scheduler.dispose();
});
