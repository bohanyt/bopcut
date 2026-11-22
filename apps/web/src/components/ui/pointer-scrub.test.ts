import { expect, test } from "bun:test";
import { startPointerScrub } from "./pointer-scrub";

function fixture() {
	const view = new EventTarget();
	const doc = Object.assign(new EventTarget(), {
		defaultView: view,
		pointerLockElement: null as EventTarget | null,
		exitPointerLock() {
			doc.pointerLockElement = null;
			doc.dispatchEvent(new Event("pointerlockchange"));
		},
	});
	const target = Object.assign(new EventTarget(), {
		ownerDocument: doc,
		requestPointerLock: () => undefined as Promise<void> | undefined,
	});
	const moves: number[] = [];
	let commits = 0;
	let cancels = 0;
	let ends = 0;

	return {
		doc,
		target,
		moves,
		commits: () => commits,
		cancels: () => cancels,
		ends: () => ends,
		lock() {
			doc.pointerLockElement = target;
			doc.dispatchEvent(new Event("pointerlockchange"));
		},
		start: () => startPointerScrub({
			target: target as unknown as HTMLElement,
			pointerId: 1,
			onMove: (delta) => moves.push(delta),
			onCommit: () => { commits++; },
			onCancel: () => { cancels++; },
			onEnd: () => { ends++; },
		}),
		event(type: string, movementX = 0, pointerId = 1) {
			const recipient = type === "lostpointercapture" ? target : doc;
			recipient.dispatchEvent(Object.assign(new Event(type), { movementX, pointerId }));
		},
	};
}

test("a scrub only commits on release after a value from the current pointer", () => {
	const f = fixture();
	f.start();
	f.lock();
	f.event("pointermove", 100);
	f.event("pointermove", 0);
	f.event("pointermove", 30, 2);
	f.event("pointerup", 0, 2);
	expect(f.ends()).toBe(0);
	f.event("pointermove", 3);
	f.event("pointerup");
	expect(f.moves).toEqual([3]);
	expect(f.commits()).toBe(1);
	expect(f.doc.pointerLockElement).toBeNull();

	f.start();
	f.lock();
	f.event("pointerup");
	expect(f.commits()).toBe(1);
	expect(f.cancels()).toBe(0);
	expect(f.ends()).toBe(2);
});

for (const reason of ["unmount", "pointercancel", "lostpointercapture", "lost pointer lock"] as const) {
	test(`scrub cancellation on ${reason} ignores late moves and the next click cannot commit`, () => {
		const f = fixture();
		const cancel = f.start();
		f.lock();
		f.event("pointermove", 100);
		f.event("pointermove", 3);
		if (reason === "unmount") cancel();
		else if (reason === "lost pointer lock") f.doc.exitPointerLock();
		else f.event(reason);
		expect(f.doc.pointerLockElement).toBeNull();
		f.event("pointermove", 4);
		f.event("pointerup");
		cancel();

		f.start();
		f.lock();
		f.event("pointerup");
		expect(f.moves).toEqual([3]);
		expect(f.cancels()).toBe(1);
		expect(f.commits()).toBe(0);
		expect(f.ends()).toBe(2);
	});
}

for (const request of ["promise", "legacy"] as const) {
	test(`cancel releases a late ${request} lock without ending a newer scrub`, async () => {
		const f = fixture();
		const ready = Promise.withResolvers<void>();
		let requests = 0;
		f.target.requestPointerLock = () => {
			requests++;
			return request === "promise" ? ready.promise : undefined;
		};
		f.start()();
		f.start();
		expect(requests).toBe(1);

		if (request === "promise") {
			f.doc.pointerLockElement = f.target;
			ready.resolve();
			await ready.promise;
		} else {
			f.lock();
		}
		expect(f.doc.pointerLockElement).toBeNull();
		f.event("pointermove", 100);
		f.event("pointermove", 3);
		f.event("pointerup");
		expect(f.moves).toEqual([3]);
		expect(f.cancels()).toBe(1);
		expect(f.commits()).toBe(1);
	});
}
