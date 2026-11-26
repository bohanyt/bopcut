import { expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main, parseArgs, renderFailed } from "./agent";
import { launchBrowser, type RunningBrowser } from "./agent-browser";
import { runRender, hiddenBrowserExitMessage } from "./agent-render";
import { isRenderAdapterStage, renderAdapterStage } from "../src/agent/render-gpu";

test.each([["default", undefined], ["low-power", "low-power"]] as const)("launches the hidden browser with GPU mode %s", (_name, mode) => {
	const browser: RunningBrowser = { exited: Promise.resolve(), stop: async () => {} };
	const start = mock((_args: string[]) => browser);
	expect(launchBrowser("http://localhost/worker", "profile", { start, env: { BOPENCUT_RENDER_GPU: mode } })).toBe(browser);
	const [args] = start.mock.lastCall!;
	expect(args).toContain("--headless");
	expect(args.includes("--force_high_performance_gpu")).toBe(mode !== "low-power");
});

test("refuses an invalid GPU mode before starting the hidden browser", () => {
	const start = mock(() => { throw new Error("unexpected browser launch"); });
	expect(() => launchBrowser("http://localhost/worker", "profile", { start, env: { BOPENCUT_RENDER_GPU: "auto" } }))
		.toThrow("Set BOPENCUT_RENDER_GPU to high-performance or low-power.");
	expect(start).not.toHaveBeenCalled();
});

test("reads the GPU override from a dotenv file and prefers the CLI environment", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "agent-render-gpu-"));
	const envFile = path.join(directory, ".env.local");
	writeFileSync(envFile, "BOPENCUT_RENDER_GPU=low-power # bypass the broken driver\n");
	try {
		const start = mock((_args: string[]): RunningBrowser => ({ exited: Promise.resolve(), stop: async () => {} }));
		launchBrowser("http://localhost/worker", "profile", { start, env: {}, envFile });
		expect(start.mock.lastCall![0]).not.toContain("--force_high_performance_gpu");
		launchBrowser("http://localhost/worker", "profile", { start, env: { BOPENCUT_RENDER_GPU: "high-performance" }, envFile });
		expect(start.mock.lastCall![0]).toContain("--force_high_performance_gpu");
	} finally {
		unlinkSync(envFile);
		rmdirSync(directory);
	}
});

test("reports only known adapter vendors and handles missing adapter information", () => {
	expect(renderAdapterStage()).toBe("graphics adapter: unknown");
	expect(renderAdapterStage("ANGLE (NVIDIA, GeForce RTX 3060, driver 1)")).toBe("graphics adapter: NVIDIA");
	expect(isRenderAdapterStage(renderAdapterStage())).toBe(true);
	expect(isRenderAdapterStage("graphics adapter: NVIDIA driver 1")).toBe(false);
});

test("validates render arguments before connecting", () => {
	expect(parseArgs(["export", "--name", "Final", "--fps", "29.97", "--allow-missing"]).request)
		.toEqual({ name: "Final", format: "mp4", quality: "very_high", fps: 29.97, includeAudio: true, allowMissing: true });
	expect(() => parseArgs(["export", "--format", "avi"])).toThrow("format");
	expect(() => parseArgs(["frames", "--compare", "{}"])).toThrow("open the editor");
	expect(() => parseArgs(["frames", "--times", "1,-1"])).toThrow("times");
	expect(parseArgs(["frames", "--element", "intro"]).request).toEqual({ elements: ["intro"], allowMissing: false });
	expect(parseArgs(["frames", "--note", "note-1", "--scene-id", "scene-1"]).request)
		.toEqual({ noteId: "note-1", sceneId: "scene-1", allowMissing: false });
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
		else if (mode === "browser exit") await expect(run).rejects.toThrow("BOPENCUT_RENDER_GPU=low-power");
		else await expect(run).rejects.toThrow(mode === "timeout" ? "loading media" : /interrupt|server|browser/i);
		expect(progress).toEqual(["loading media"]);
		expect(starts).toBe(mode === "visible" ? 0 : 1);
		expect(stops).toBe(starts);
	});
}

test("a hidden browser that ends says how and when, and why when it closed at once", () => {
	const quick = hiddenBrowserExitMessage({ code: 0, signal: null, afterMs: 300 });
	expect(quick).toContain("(exit code 0 after 0.3 s)");
	expect(quick).toContain("HeadlessModeEnabled");
	expect(quick).toContain("UserDataDir");
	const crash = hiddenBrowserExitMessage({ code: 3221225477, signal: null, afterMs: 12_000 });
	expect(crash).toContain("(exit code 3221225477 after 12.0 s)");
	expect(crash).toContain("BOPENCUT_RENDER_GPU=low-power");
	expect(hiddenBrowserExitMessage({ error: "spawn msedge.exe ENOENT", afterMs: 1 })).toContain("could not start (spawn msedge.exe ENOENT)");
	expect(hiddenBrowserExitMessage(undefined)).toContain("The hidden browser exited. Open the project");
});

test("the render stream reports how the hidden browser ended", async () => {
	const response = new Response(new ReadableStream<Uint8Array>({
		start(stream) {
			stream.enqueue(new TextEncoder().encode(JSON.stringify({ launch: "http://localhost/worker", profile: "profile" }) + "\n"));
		},
	}));
	const run = runRender(response, {
		timeoutMs: 5000,
		signal: new AbortController().signal,
		progress: () => {},
		launch: () => ({ exited: Promise.resolve({ code: 0, signal: null, afterMs: 400 }), stop: async () => {} }),
	});
	await expect(run).rejects.toThrow("(exit code 0 after 0.4 s) before opening the page");
});
