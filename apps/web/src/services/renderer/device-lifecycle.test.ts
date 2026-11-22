import { describe, expect, test } from "bun:test";
import { DeviceLifecycle } from "./device-lifecycle";

function setup() {
	const attempts: Array<{
		lost: () => void;
		result: ReturnType<typeof Promise.withResolvers<void>>;
	}> = [];
	const recoveries: Array<() => void> = [];
	const device = new DeviceLifecycle({
		initialize: (lost) => {
			const result = Promise.withResolvers<void>();
			attempts.push({ lost, result });
			return result.promise;
		},
		scheduleRecovery: (run) => recoveries.push(run),
	});
	return { device, attempts, recoveries };
}

describe("GPU device lifecycle", () => {
	test("shares initialization, exposes failure, and retries only on request", async () => {
		const { device, attempts } = setup();
		const start = device.start();
		expect(device.start()).toBe(start);
		attempts[0].result.reject("Both adapters failed");
		await start;
		expect(device.status).toEqual({ state: "unavailable", detail: "Both adapters failed" });
		expect(() => device.requireReady()).toThrow("Preview and export");
		await device.start();
		expect(attempts).toHaveLength(1);

		const retry = device.retry();
		attempts[1].result.resolve();
		await retry;
		expect(device.status.state).toBe("ready");
		expect(device.requireReady().aborted).toBe(false);
	});

	test("invalidates in-flight work, then wakes paused callers once on recovery", async () => {
		const { device, attempts, recoveries } = setup();
		const start = device.start();
		attempts[0].result.resolve();
		await start;
		const signal = device.requireReady();
		const states: string[] = [];
		device.subscribe(() => states.push(device.status.state));
		attempts[0].lost();
		attempts[0].lost();
		expect(signal.aborted).toBe(true);
		expect(() => device.requireReady()).toThrow("Graphics device");
		expect(recoveries).toHaveLength(1);

		recoveries[0]();
		attempts[1].result.resolve();
		await device.start();
		expect(device.requireReady()).not.toBe(signal);
		attempts[0].lost();
		expect(states).toEqual(["recovering", "ready"]);
	});

	test("a recovery that loses its device during setup ends at Retry", async () => {
		const { device, attempts, recoveries } = setup();
		const start = device.start();
		attempts[0].result.resolve();
		await start;
		attempts[0].lost();
		recoveries[0]();
		attempts[1].lost();
		attempts[1].result.resolve();
		await device.start();
		expect(device.status.state).toBe("unavailable");
		expect(recoveries).toHaveLength(1);
	});

	test("a ready device that fails its first frame cannot loop through recreation", async () => {
		const { device, attempts, recoveries } = setup();
		const start = device.start();
		attempts[0].result.resolve();
		await start;
		attempts[0].lost();
		recoveries[0]();
		attempts[1].result.resolve();
		await device.start();
		attempts[1].lost();
		expect(device.status.state).toBe("unavailable");
		expect(recoveries).toHaveLength(1);

		const retry = device.retry();
		attempts[2].result.resolve();
		await retry;
		device.markFramePresented();
		attempts[2].lost();
		expect(recoveries).toHaveLength(2);
	});
});
