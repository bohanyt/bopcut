import { expect, spyOn, test } from "bun:test";
import { main, parseArgs, renderFailed } from "./agent";
import { runRender } from "./agent-render";

test("validates render arguments before connecting", () => {
	expect(parseArgs(["export", "--name", "Final", "--fps", "29.97", "--allow-missing"]).request)
		.toEqual({ name: "Final", format: "mp4", quality: "high", fps: 29.97, includeAudio: true, allowMissing: true });
	expect(() => parseArgs(["export", "--format", "avi"])).toThrow("format");
	expect(() => parseArgs(["frames", "--compare", "{}"])).toThrow("open the editor");
	expect(() => parseArgs(["frames", "--times", "1,-1"])).toThrow("times");
	expect(parseArgs(["frames", "--element", "intro"]).request).toEqual({ elements: ["intro"], allowMissing: false });
	expect(() => parseArgs(["status", "--name", "Final"])).toThrow();
});

test("fails a frame command when all requested frames have errors", () => {
	expect(renderFailed("frames", { files: [], errors: [{ time: 30, error: "Time outside timeline" }] })).toBe(true);
	expect(renderFailed("frames", { files: ["0.jpg"], errors: [{ time: 30, error: "Time outside timeline" }] })).toBe(false);
});

test("render timeouts keep the default and supported range", () => {
	for (const args of [["export"], ["frames", "--times", "0"]]) {
		expect(parseArgs(args).timeoutMs).toBe(600_000);
		expect(parseArgs([...args, "--timeout", "10"]).timeoutMs).toBe(10_000);
		expect(parseArgs([...args, "--timeout", "0.001"], 0).timeoutMs).toBe(1);
		expect(() => parseArgs([...args, "--timeout", "9.9"])).toThrow("at least 10 seconds");
		expect(parseArgs([...args, "--timeout", "86400"]).timeoutMs).toBe(86_400_000);
		expect(() => parseArgs([...args, "--timeout", "86401"])).toThrow("--timeout");
	}
});

test.each(["export", "frames"])("%s runs past its timeout when the stage changes", async (command) => {
	const result = { rev: "test", status: "done" };
	const events = [{ stage: "loading media" }, { stage: "rendering" }, { stage: "uploading" }, { result }];
	let cancelled = false;
	const fetchRender = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
		async pull(stream) {
			await Bun.sleep(100);
			if (cancelled) return;
			stream.enqueue(new TextEncoder().encode(JSON.stringify(events.shift()) + "\n"));
			if (!events.length) stream.close();
		},
		cancel() { cancelled = true; },
	})));
	try {
		const args = command === "frames" ? [command, "--times", "0"] : [command];
		expect(await main([...args, "--timeout", "0.3"], 0)).toEqual(result);
	} finally {
		fetchRender.mockRestore();
	}
});

test("a repeated stage cannot keep a stalled CLI render alive", async () => {
	let cancelled = false;
	let sends = 0;
	const fetchRender = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
		async pull(stream) {
			await Bun.sleep(40);
			if (cancelled) return;
			stream.enqueue(new TextEncoder().encode('{"stage":"encoding 42%"}\n'));
			if (++sends === 15) stream.close();
		},
		cancel() { cancelled = true; },
	})));
	try {
		await expect(main(["export", "--timeout", "0.25"], 0)).rejects.toThrow(
			"Timed out after 0.25 s without progress while encoding 42%. Increase --timeout and retry.",
		);
		expect(sends).toBeGreaterThan(1);
		expect(cancelled).toBe(true);
	} finally {
		fetchRender.mockRestore();
	}
});

test("the CLI bounds the initial connection and suggests opening the editor", async () => {
	const connect = async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const signal = init!.signal!;
		return await new Promise<Response>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	};
	const fetchRender = spyOn(globalThis, "fetch").mockImplementation(Object.assign(connect, { preconnect: fetch.preconnect }));
	try {
		await expect(main(["export", "--timeout", "0.04"], 0)).rejects.toThrow(
			"Timed out after 0.04 s without progress while waiting for a tab. Open the editor and retry, or increase --timeout.",
		);
	} finally {
		fetchRender.mockRestore();
	}
});

for (const mode of ["visible", "done", "error", "timeout", "interrupt", "server stop", "browser exit"] as const) {
	test(`render stream cleans up after ${mode}`, async () => {
		const events = [{ stage: "loading media" }, ...(mode === "visible" ? [] : [{ launch: "http://localhost/worker", profile: "profile" }])];
		const result = { rev: "test", status: "done" };
		const controller = new AbortController();
		let starts = 0;
		let stops = 0;
		const progress: string[] = [];
		const response = new Response(new ReadableStream<Uint8Array>({
			start(stream) {
				for (const event of events) stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
				if (mode === "visible" || mode === "done" || mode === "error") {
					stream.enqueue(new TextEncoder().encode(JSON.stringify({ result: mode === "error" ? { error: "encoding failed" } : result }) + "\n"));
				}
				if (!["interrupt", "timeout", "browser exit"].includes(mode)) stream.close();
			},
		}));
		const run = runRender(response, {
			timeoutMs: mode === "timeout" ? 30 : 5000,
			signal: controller.signal,
			progress: (stage) => progress.push(stage),
			launch: () => {
				starts++;
				if (mode === "interrupt") queueMicrotask(() => controller.abort(new Error("Interrupted by Ctrl+C.")));
				return { exited: mode === "browser exit" ? Promise.resolve() : new Promise(() => {}), stop: async () => { stops++; } };
			},
		});
		if (mode === "visible" || mode === "done") expect(await run).toEqual(result);
		else if (mode === "error") expect(await run).toEqual({ error: "encoding failed" });
		else await expect(run).rejects.toThrow(mode === "timeout" ? "loading media" : /interrupt|server|browser/i);
		expect(progress).toEqual(["loading media"]);
		expect(starts).toBe(mode === "visible" ? 0 : 1);
		expect(stops).toBe(starts);
	});
}
