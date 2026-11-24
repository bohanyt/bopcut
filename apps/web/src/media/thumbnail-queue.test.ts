import { expect, test } from "bun:test";
import { ThumbnailQueue } from "./thumbnail-queue";

function harness() {
	let busy = false;
	let check: (() => void) | undefined;
	let idle: (() => void) | undefined;
	const queue = new ThumbnailQueue({
		busy: () => busy,
		watch: (listener) => {
			check = listener;
			return () => { check = undefined; };
		},
		idle: (run) => {
			idle = run;
			return () => { idle = undefined; };
		},
	});
	return {
		queue,
		active: () => !!check,
		scheduled: () => !!idle,
		setBusy(value: boolean) { busy = value; check?.(); },
		tick() {
			const callback = idle;
			idle = undefined;
			callback?.();
		},
	};
}

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("runs visible requests newest first with one decode in flight", async () => {
	const h = harness();
	const seen: string[] = [];
	const first = {};
	const latest = {};
	const done = Promise.withResolvers<void>();
	const cancelOld = h.queue.request(first, async () => { seen.push("old"); });
	h.queue.request(latest, async () => { seen.push("new"); await done.promise; });
	h.queue.request(latest, async () => { seen.push("duplicate"); });
	h.tick();
	h.tick();
	expect(seen).toEqual(["new"]);
	expect(h.scheduled()).toBe(false);
	done.resolve();
	await settle();
	h.tick();
	await settle();
	expect(seen).toEqual(["new", "old"]);
	cancelOld();
	h.queue.request(latest, async () => { seen.push("shown again"); });
	expect(h.active()).toBe(false);
	expect(h.scheduled()).toBe(false);
});

test("cancels on activity and resumes when idle, with no background listener after release", async () => {
	const h = harness();
	const jobs: AbortSignal[] = [];
	const key = {};
	h.setBusy(true);
	const cancel = h.queue.request(key, async (signal) => {
		jobs.push(signal);
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	expect(h.scheduled()).toBe(false);
	h.setBusy(false);
	h.tick();
	expect(jobs).toHaveLength(1);
	h.setBusy(true);
	expect(jobs[0].aborted).toBe(true);
	await settle();
	h.setBusy(false);
	h.tick();
	expect(jobs).toHaveLength(2);
	cancel();
	expect(jobs[1].aborted).toBe(true);
	expect(h.active()).toBe(false);
	expect(h.scheduled()).toBe(false);
});

test("fails once per session, discards offscreen work, and aborts the running decode on close", async () => {
	const h = harness();
	const failed = {};
	let attempts = 0;
	const decode = async () => { attempts++; throw new Error("unreadable"); };
	h.queue.request(failed, decode);
	h.tick();
	await settle();
	h.queue.request(failed, decode);
	expect(attempts).toBe(1);
	expect(h.scheduled()).toBe(false);
	let running: AbortSignal | undefined;
	const cancel = h.queue.request({}, decode);
	cancel();
	h.queue.request({}, async (signal) => {
		running = signal;
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	});
	h.tick();
	h.queue.request({}, decode);
	h.queue.clear();
	expect(running?.aborted).toBe(true);
	expect(h.scheduled()).toBe(false);
	await settle();
	expect(attempts).toBe(1);
	h.queue.request(failed, decode);
	h.tick();
	await settle();
	expect(attempts).toBe(2);
});
