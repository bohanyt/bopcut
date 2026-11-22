import { expect, test } from "bun:test";
import { parseArgs } from "./agent";
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
			signal: controller.signal,
			progress: (stage) => progress.push(stage),
			launch: () => {
				starts++;
				if (mode === "interrupt" || mode === "timeout") queueMicrotask(() => controller.abort(
					new DOMException(mode, mode === "timeout" ? "TimeoutError" : "AbortError"),
				));
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
