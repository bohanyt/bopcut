import { expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MAX_RENDER_QUEUE, renderPresence, renderRequest, renderWorker, startRender } from "./render-server";
import { profileDirectory, recordOutput, recoverRenderJobs } from "./render-output";
import { MAX_RANGE_PNG } from "./range-view";

const url = "http://127.0.0.1/api/agent/cli/render";
const tokenHeader = "x-bopencut-render-token";
const runInAnotherProcess = (code: string, ...args: string[]) =>
	promisify(execFile)(process.execPath, ["-e", code, ...args], { cwd: path.join(import.meta.dir, "../.."), timeout: 5000 });
const begin = (signal?: AbortSignal, timeoutMs = 10_000) => new Request(url, {
	signal, method: "POST", body: JSON.stringify({ command: "export", request: {}, timeoutMs }),
});
const visible = (project = "project") => new Request(url, { headers: {
	"x-bopencut-project": project, "x-bopencut-render-tab": "visible", "x-bopencut-ready": "1",
} });

test("a range view bypasses the visible editor and accepts one bounded PNG from its hidden worker", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-range-render-"));
	const beginView = (to: number) => new Request(url, {
		method: "POST", body: JSON.stringify({ command: "view", request: { from: 1, to, rows: 2 }, timeoutMs: 10_000 }),
	});
	let reader: ReadableStreamDefaultReader<string> | undefined;
	try {
		expect((await startRender(beginView(150), workspace, async () => "project")).status).toBe(400);
		renderPresence(visible());
		const response = await startRender(beginView(3), workspace, async () => "project", { profileRoot: workspace });
		reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		const next = async () => JSON.parse((await reader!.read()).value!);
		expect(await next()).toEqual({ stage: "waiting for a tab" });
		const offer = await next();
		const key = new URL(offer.launch).pathname.split("/").at(-1);
		expect(await (await renderRequest(visible(), "frames", workspace)).json()).toBeNull();
		expect(await (await renderRequest(visible(), "export", workspace)).json()).toBeNull();
		const claim = await renderWorker(new Request(`${url}?key=${key}`), workspace);
		const { rev } = await claim.json();
		expect(claim.headers.get("x-bopencut-render-kind")).toBe("view");
		expect(await next()).toEqual({ stage: "loading project" });
		const headers = { [tokenHeader]: claim.headers.get(tokenHeader)! };
		const watch = renderWorker(new Request(`${url}?action=watch`, { headers }), workspace);
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64");
		const upload = (size: number) => renderWorker(new Request(`${url}?action=view-file`, {
			method: "POST", headers: { ...headers, "Content-Type": "image/png", "Content-Length": String(size) },
			body: new Blob([png], { type: "image/png" }),
		}), workspace);
		expect((await upload(MAX_RANGE_PNG + 1)).status).toBe(400);
		const result = upload(png.length);
		expect(await next()).toEqual({ stage: "saving range picture" });
		const file = `views/${rev}.png`;
		expect((await next()).result).toMatchObject({ file, from: 1, to: 3, rows: 2, bytes: png.length });
		expect((await result).ok).toBe(true);
		expect(await readFile(path.join(workspace, file))).toEqual(png);
		expect(await reader.read()).toMatchObject({ done: true });
		expect((await watch).ok).toBe(true);
	} finally {
		await reader?.cancel();
		await rm(workspace, { recursive: true, force: true });
	}
});

test.each(["completes", "stalls"] as const)("a server render %s according to stage changes", async (outcome) => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-deadline-"));
	let reader: ReadableStreamDefaultReader<string> | undefined;
	try {
		const response = await startRender(begin(undefined, 350), workspace, async () => "project", { claim: 3000 });
		reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		const claim = await renderRequest(visible(), "export", workspace);
		const { rev, projectId } = await claim.json();
		const headers = { [tokenHeader]: claim.headers.get(tokenHeader)! };
		const watching = renderWorker(new Request(`${url}?action=watch`, { headers }), workspace);
		const progress = (progress: number) => renderWorker(new Request(`${url}?action=export-result`, {
			method: "POST", headers, body: JSON.stringify({ rev, projectId, status: "exporting", progress }),
		}), workspace);
		expect(JSON.parse((await reader.read()).value!)).toEqual({ stage: "waiting for a tab" });
		if (outcome === "completes") {
			for (let step = 1; step <= 12; step++) {
				await Bun.sleep(120);
				expect((await progress(step / 100)).ok).toBe(true);
			}
			const query = new URLSearchParams({ action: "export-file", rev, projectId, name: "Long", format: "mp4" });
			expect((await renderWorker(new Request(`${url}?${query}`, { method: "POST", headers, body: "video" }), workspace)).ok).toBe(true);
		} else {
			expect((await progress(0.42)).ok).toBe(true);
			let repeats = 0;
			for (; repeats < 10; repeats++) {
				await Bun.sleep(75);
				renderPresence(visible());
				if (!(await progress(0.42)).ok) break;
			}
			expect(repeats).toBeGreaterThan(0);
			expect(repeats).toBeLessThan(10);
		}
		let result;
		for (;;) {
			const event = await reader.read();
			if (event.done) break;
			result = JSON.parse(event.value).result ?? result;
		}
		if (outcome === "completes") expect(result).toMatchObject({ rev, projectId, status: "done", file: "exports/Long.mp4" });
		else expect(result).toMatchObject({ rev, projectId, error: "Timed out after 0.35 s without progress while encoding 42%. Increase --timeout and retry." });
		expect((await watching).ok).toBe(true);
		expect(await readdir(path.join(workspace, ".render-jobs"))).toEqual([]);
		const next = await startRender(begin(), workspace, async () => "project");
		expect(next.ok).toBe(true);
		await next.body!.cancel();
	} finally {
		await reader?.cancel();
		await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
	}
});

for (const owner of ["visible", "hidden"] as const) {
	test(`${owner} owns its only render, with legacy results preserved until publication`, async () => {
		const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-"));
		const resultPath = path.join(workspace, "export-result.json");
		let reader: ReadableStreamDefaultReader<string> | undefined;
		try {
			await writeFile(resultPath, '{"rev":"legacy","status":"done"}');
			const scratch = path.join(workspace, ".render-jobs");
			await mkdir(path.join(scratch, "cli-01234567-0000-0000-0000-012345678901"), { recursive: true });
			const response = await startRender(begin(), workspace, async () => "project", { grace: 80, seen: 80, profileRoot: workspace });
			reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
			const next = async () => JSON.parse((await reader!.read()).value!);
			expect(await next()).toEqual({ stage: "waiting for a tab" });
			expect(await readdir(scratch)).toHaveLength(1);
			expect(await readdir(scratch)).not.toContain("cli-01234567-0000-0000-0000-012345678901");
			// A second render waits in the queue instead of failing; it leaves the queue when its client goes.
			const queued = new AbortController();
			const second = await startRender(begin(queued.signal), workspace, async () => "project");
			const secondReader = second.body!.pipeThrough(new TextDecoderStream()).getReader();
			expect(JSON.parse((await secondReader.read()).value!).stage).toMatch(/^waiting in the render queue \(1 ahead/);
			queued.abort();
			await secondReader.cancel();
			let claim: Response;
			if (owner === "hidden") {
				const offer = await next();
				const key = new URL(offer.launch).pathname.split("/").at(-1);
				expect(await (await renderRequest(visible(), "export", workspace)).json()).toBeNull();
				const request = new Request(`${url}?key=${key}`);
				claim = await renderWorker(request, workspace);
				expect((await renderWorker(request, workspace)).status).toBe(404);
				expect(await next()).toEqual({ stage: "loading project" });
				expect(await (await renderRequest(visible(), "export", workspace)).json()).toBeNull();
			} else {
				expect((await renderWorker(new Request(`${url}?key=normal-visit`), workspace)).status).toBe(404);
				expect(await (await renderRequest(visible("different"), "export", workspace)).json()).toBeNull();
				claim = await renderRequest(visible(), "export", workspace);
			}
			const token = claim.headers.get(tokenHeader)!;
			const request = await claim.json();
			expect(request).toMatchObject({ projectId: "project", format: "mp4" });
			const post = (action: string, body: object, sequence?: number) => renderWorker(new Request(`${url}?action=${action}`, {
				method: "POST", headers: { [tokenHeader]: token, ...(sequence && { "x-bopencut-render-stage-sequence": String(sequence) }) }, body: JSON.stringify(body),
			}), workspace);
			for (const action of ["draft", "applied", "sync", "selection", "edits", "retrieve", "gif"]) {
				expect((await post(action, {})).status).toBe(403);
			}
			await post("export-result", { rev: request.rev, projectId: "project", status: "exporting", progress: 0.42 });
			expect(await next()).toEqual({ stage: "encoding 42%" });
			for (const frame of [4201, 4202]) {
				await post("export-result", { rev: request.rev, projectId: "project", status: "exporting", progress: 0.42, frame });
				expect(await next()).toEqual({ stage: `encoding 42% (frame ${frame})` });
			}
			await post("stage", { stage: "finalizing video" }, 5);
			expect(await next()).toEqual({ stage: "finalizing video" });
			await post("stage", { stage: "starting encoding" }, 2);
			await post("export-result", { rev: request.rev, projectId: "project", status: "exporting", progress: 0.43, frame: 4300 }, 4);
			expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ rev: "legacy", status: "done" });
			const query = new URLSearchParams({ action: "export-file", rev: request.rev, projectId: "project", name: "Final", format: "mp4", result: '{"format":"mp4","fps":30}' });
			const saved = renderWorker(new Request(`${url}?${query}`, {
				method: "POST", headers: { [tokenHeader]: token }, body: "video",
			}), workspace);
			expect(await next()).toEqual({ stage: "uploading video" });
			expect(await next()).toEqual({ stage: "saving video" });
			const { result } = await next();
			expect(await (await saved).json()).toEqual({ file: "exports/Final.mp4", bytes: 5 });
			expect(result).toMatchObject({ rev: request.rev, projectId: "project", status: "done", fps: 30 });
			expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ rev: "legacy", status: "done" });
			expect(await readFile(path.join(workspace, result.file), "utf8")).toBe("video");
			expect(await reader.read()).toMatchObject({ done: true });
		} finally {
			await reader?.cancel();
			await rm(workspace, { recursive: true, force: true });
		}
	}, 10000);
}

test("a stopped CLI connection during publication aborts the upload and preserves the last result", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-stop-"));
	const controller = new AbortController();
	try {
		const resultPath = path.join(workspace, "export-result.json");
		await writeFile(resultPath, '{"rev":"legacy","status":"done"}');
		const stream = await startRender(begin(controller.signal), workspace, async () => "project");
		const reader = stream.body!.getReader();
		await reader.read();
		const claim = await renderRequest(visible(), "export", workspace);
		const { rev } = await claim.json();
		const query = new URLSearchParams({ action: "export-file", rev, projectId: "project", name: "Incomplete", format: "mp4" });
		const stalled = Promise.withResolvers<void>();
		const end = Promise.withResolvers<void>();
		let cancelled = false;
		const upload = renderWorker(new Request(`${url}?${query}`, {
			method: "POST", headers: { [tokenHeader]: claim.headers.get(tokenHeader)! },
			body: new ReadableStream({
				start: (body) => body.enqueue(new Uint8Array(1024)),
				pull: () => {
					stalled.resolve();
					return end.promise;
				},
				cancel: () => {
					cancelled = true;
					end.resolve();
				},
			}, { highWaterMark: 0 }),
		}), workspace);
		expect(JSON.parse(new TextDecoder().decode((await reader.read()).value))).toEqual({ stage: "uploading video" });
		await stalled.promise;
		controller.abort();
		expect((await upload).ok).toBe(false);
		expect(cancelled).toBe(true);
		expect(await reader.read()).toMatchObject({ done: true });
		expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ rev: "legacy", status: "done" });
		expect(await readdir(path.join(workspace, "exports")).catch(() => [])).toEqual([]);
	} finally {
		controller.abort();
		await rm(workspace, { recursive: true, force: true });
	}
});

test("an upload that keeps writing bytes can finish past the stall interval", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-upload-"));
	let reader: ReadableStreamDefaultReader<string> | undefined;
	try {
		const response = await startRender(begin(undefined, 3000), workspace, async () => "project");
		reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		const next = async () => JSON.parse((await reader!.read()).value!);
		expect(await next()).toEqual({ stage: "waiting for a tab" });
		const claim = await renderRequest(visible(), "export", workspace);
		const { rev, projectId } = await claim.json();
		const query = new URLSearchParams({ action: "export-file", rev, projectId, name: "Slow", format: "mp4" });
		let chunks = 0;
		let cancelled = false;
		const upload = renderWorker(new Request(`${url}?${query}`, {
			method: "POST", headers: { [tokenHeader]: claim.headers.get(tokenHeader)! },
			body: new ReadableStream({
				async pull(stream) {
					await Bun.sleep(2150);
					if (cancelled) return;
					stream.enqueue(new Uint8Array(1024));
					if (++chunks === 2) stream.close();
				},
				cancel() { cancelled = true; },
			}, { highWaterMark: 0 }),
		}), workspace);
		expect(await next()).toEqual({ stage: "uploading video" });
		expect(await next()).toEqual({ stage: "uploading video (1024 bytes)" });
		expect(await next()).toEqual({ stage: "uploading video (2048 bytes)" });
		expect(await next()).toEqual({ stage: "saving video" });
		expect((await next()).result).toMatchObject({ status: "done", bytes: 2048 });
		expect((await upload).ok).toBe(true);
		expect(await reader.read()).toMatchObject({ done: true });
	} finally {
		await reader?.cancel();
		await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
	}
}, 8000);

test("pending legacy frame requests retain both files during a CLI render", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-legacy-"));
	const controller = new AbortController();
	try {
		const reqFile = path.join(workspace, "frames-request.json");
		const resFile = path.join(workspace, "frames-result.json");
		const legacy = { rev: "legacy", times: [0] };
		const refusal = { rev: "legacy", files: [], missingMedia: [{ name: "clip" }] };
		await writeFile(reqFile, JSON.stringify(legacy));
		await writeFile(resFile, JSON.stringify(refusal));
		const response = await startRender(new Request(url, {
			method: "POST", signal: controller.signal,
			body: JSON.stringify({ command: "frames", request: { times: [0] }, timeoutMs: 10000 }),
		}), workspace, async () => "project");
		expect(response.ok).toBe(true);
		const claim = await renderRequest(visible(), "frames", workspace);
		const { rev } = await claim.json();
		await renderWorker(new Request(`${url}?action=frames-result`, {
			method: "POST", headers: { [tokenHeader]: claim.headers.get(tokenHeader)! },
			body: JSON.stringify({ rev, projectId: "project", files: [] }),
		}), workspace);
		await response.text();
		expect(JSON.parse(await readFile(reqFile, "utf8"))).toEqual(legacy);
		expect(JSON.parse(await readFile(resFile, "utf8"))).toEqual(refusal);
	} finally {
		controller.abort();
		await rm(workspace, { recursive: true, force: true });
	}
});

test.each(["unready", "disconnected", "expired"] as const)("the hidden worker takes over from a %s visible tab", async (state) => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-handoff-"));
	const controller = new AbortController();
	const disconnect = new AbortController();
	let tick: ReturnType<typeof setInterval> | undefined;
	let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		renderPresence(visible());
		const response = await startRender(begin(controller.signal), workspace, async () => "project", { grace: 40, seen: 40, claim: 40, profileRoot: workspace });
		expect(response.ok).toBe(true);
		stream = response.body!.getReader();
		await stream.read();
		if (state === "unready") {
			tick = setInterval(() => renderPresence(visible()), 5);
		} else {
			const claim = await renderRequest(visible(), "export", workspace);
			if (state === "disconnected") {
				const watching = renderWorker(new Request(`${url}?action=watch`, {
					signal: disconnect.signal, headers: { [tokenHeader]: claim.headers.get(tokenHeader)! },
				}), workspace);
				disconnect.abort();
				await watching;
			}
		}
		expect(JSON.parse(new TextDecoder().decode((await stream.read()).value)).launch).toContain("/agent/render/");
	} finally {
		clearInterval(tick);
		await stream?.cancel();
		controller.abort();
		await rm(workspace, { recursive: true, force: true });
	}
}, 1500);

test("a failed result publication removes the promoted export", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-publish-"));
	const controller = new AbortController();
	const renameFile = fs.rename;
	const failedRename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (typeof to === "string" && to.endsWith("export-result.json")) throw new Error("Could not publish result");
		await renameFile(from, to);
	});
	try {
		const response = await startRender(begin(controller.signal), workspace, async () => "project");
		const claim = await renderRequest(visible(), "export", workspace);
		const { rev } = await claim.json();
		const query = new URLSearchParams({ action: "export-file", rev, projectId: "project", name: "Uncommitted", format: "mp4" });
		const uploaded = await renderWorker(new Request(`${url}?${query}`, {
			method: "POST", headers: { [tokenHeader]: claim.headers.get(tokenHeader)! }, body: "video",
		}), workspace);
		expect(uploaded.ok).toBe(false);
		expect(await readdir(path.join(workspace, "exports"))).toEqual([]);
		await response.body!.cancel();
	} finally {
		failedRename.mockRestore();
		controller.abort();
		await rm(workspace, { recursive: true, force: true });
	}
});

test("a second server's recovery preserves an active render and its promoted output", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-shared-"));
	const renameFile = fs.rename;
	const duringPublish = spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (typeof to === "string" && to.endsWith("export-result.json")) {
			await runInAnotherProcess(
				'import { recoverRenderJobs } from "./src/agent/render-output"; await recoverRenderJobs(process.argv[1]);',
				workspace,
			);
		}
		await renameFile(from, to);
	});
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const response = await startRender(begin(), workspace, async () => "project", { profileRoot: workspace });
		expect(response.ok).toBe(true);
		reader = response.body!.getReader();
		const claim = await renderRequest(visible(), "export", workspace);
		const { rev } = await claim.json();
		const query = new URLSearchParams({ action: "export-file", rev, projectId: "project", name: "Active", format: "mp4" });
		const uploaded = await renderWorker(new Request(`${url}?${query}`, {
			method: "POST", headers: { [tokenHeader]: claim.headers.get(tokenHeader)! }, body: "video",
		}), workspace);
		expect(await uploaded.json()).toEqual({ file: "exports/Active.mp4", bytes: 5 });
		expect(await readFile(path.join(workspace, "exports", "Active.mp4"), "utf8")).toBe("video");
		while (!(await reader.read()).done) { /* Wait for server cleanup. */ }
		expect(await readdir(path.join(workspace, ".render-jobs"))).toEqual([]);
	} finally {
		duringPublish.mockRestore();
		await reader?.cancel();
		await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
	}
}, 10000);

test.each(["retry", "cancel"] as const)("a promoted frame survives failed result publication until %s", async (outcome) => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-frame-retry-"));
	const controller = new AbortController();
	const renameFile = fs.rename;
	const failedRename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
		if (typeof to === "string" && to.endsWith("frames-result.json")) throw new Error("Could not publish result");
		await renameFile(from, to);
	});
	let response: Response | undefined;
	try {
		response = await startRender(new Request(url, {
			method: "POST", signal: controller.signal,
			body: JSON.stringify({ command: "frames", request: { times: [0] }, timeoutMs: 10000 }),
		}), workspace, async () => "project", { grace: 0, seen: 0, profileRoot: workspace });
		const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		await reader.read();
		const { launch } = JSON.parse((await reader.read()).value!);
		const key = new URL(launch).pathname.split("/").at(-1);
		const claim = await renderWorker(new Request(`${url}?key=${key}`), workspace);
		const { rev, projectId } = await claim.json();
		const headers = { [tokenHeader]: claim.headers.get(tokenHeader)! };
		const watching = renderWorker(new Request(`${url}?action=watch`, { headers }), workspace);
		const post = (action: string, body: BodyInit) => renderWorker(new Request(`${url}?action=${action}`, {
			method: "POST", headers, body,
		}), workspace);
		expect((await post("stage", JSON.stringify({ stage: "graphics adapter: driver details" }))).ok).toBe(true);
		expect((await post("stage", JSON.stringify({ stage: "graphics adapter: unknown" }))).ok).toBe(true);
		expect(JSON.parse((await reader.read()).value!)).toEqual({ stage: "loading project" });
		expect(JSON.parse((await reader.read()).value!)).toEqual({ stage: "graphics adapter: unknown" });
		const form = new FormData();
		form.set("rev", rev);
		form.set("time", "0");
		form.set("image", new File(["jpeg"], "0.jpg", { type: "image/jpeg" }));
		const frame = await post("frame", form);
		expect(frame.status).toBe(200);
		const { file } = await frame.json();
		const result = { rev, projectId, files: [file] };
		const resultBody = JSON.stringify(result);
		const rejected = await post("frames-result", resultBody);
		expect(rejected.status).toBe(500);
		expect(await rejected.json()).toEqual({ error: "Could not publish result" });
		expect(await readFile(path.join(workspace, file), "utf8")).toBe("jpeg");
		if (outcome === "retry") {
			failedRename.mockRestore();
			expect((await post("frames-result", resultBody)).ok).toBe(true);
			expect(JSON.parse((await reader.read()).value!)).toEqual({ stage: "saving" });
			expect(JSON.parse((await reader.read()).value!)).toEqual({ result });
			expect(await reader.read()).toMatchObject({ done: true });
			expect(await readFile(path.join(workspace, file), "utf8")).toBe("jpeg");
		} else {
			controller.abort();
			expect(JSON.parse((await reader.read()).value!)).toEqual({ stage: "saving" });
			expect(await reader.read()).toMatchObject({ done: true });
			expect(await readdir(path.join(workspace, "frames"))).toEqual([]);
		}
		await watching;
		expect(await readdir(path.join(workspace, ".render-jobs"))).toEqual([]);
	} finally {
		failedRename.mockRestore();
		controller.abort();
		await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
	}
});

test("a hidden claim without a watch reports a registration timeout and releases the render slot", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-watch-timeout-"));
	const controller = new AbortController();
	const watchdog = setTimeout(() => controller.abort(), 1000);
	try {
		const options = { grace: 0, seen: 0, watchRegistration: 40, profileRoot: workspace };
		const response = await startRender(begin(controller.signal), workspace, async () => "project", options);
		expect(response.ok).toBe(true);
		const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		await reader.read();
		const { launch } = JSON.parse((await reader.read()).value!);
		const key = new URL(launch).pathname.split("/").at(-1);
		const claim = await renderWorker(new Request(`${url}?key=${key}`), workspace);
		expect(claim.ok).toBe(true);
		const { rev, projectId } = await claim.json();
		expect(JSON.parse((await reader.read()).value!)).toEqual({ stage: "loading project" });
		const terminal = await reader.read();
		expect(terminal.done).toBe(false);
		expect(JSON.parse(terminal.value!)).toEqual({ result: {
			rev, projectId, error: "The hidden browser did not register its render connection. If graphics could not start, retry with BOPENCUT_RENDER_GPU=low-power.",
		} });
		expect(await reader.read()).toMatchObject({ done: true });
		expect(await readdir(path.join(workspace, ".render-jobs"))).toEqual([]);
		const next = await startRender(begin(), workspace, async () => "project", options);
		expect(next.ok).toBe(true);
		await next.body!.cancel();
	} finally {
		clearTimeout(watchdog);
		controller.abort();
		await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
	}
});

test("recovery rolls back a promoted file only when it is owned and uncommitted", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-recovery-"));
	try {
		await recoverRenderJobs(workspace); // An earlier job already completed its startup scan.
		const output = path.join(workspace, "exports");
		await mkdir(output);
		const revs = ["abandoned", "completed", "existing"].map((_, index) => `cli-01234567-0000-0000-0000-01234567890${index}`);
		const { stdout } = await runInAnotherProcess(
			'import { renderJobDir } from "./src/agent/render-output"; console.log(JSON.stringify(process.argv.slice(2).map(rev => renderJobDir(process.argv[1], rev))));',
			workspace, ...revs,
		);
		const jobDirs: string[] = JSON.parse(stdout);
		for (const [index, name] of ["abandoned", "completed", "existing"].entries()) {
			const rev = revs[index];
			const scratch = jobDirs[index];
			await mkdir(scratch, { recursive: true });
			const source = path.join(scratch, "render.part");
			await writeFile(source, "render");
			const target = path.join(output, `${name}.mp4`);
			await recordOutput(workspace, scratch, target, source);
			if (name === "existing") await writeFile(target, "legacy");
			else await rename(source, target);
			if (name === "completed") await writeFile(path.join(scratch, "export-result.json"), JSON.stringify({ rev, status: "done", file: `exports/${name}.mp4` }));
		}
		await recoverRenderJobs(workspace);
		expect((await readdir(output)).sort()).toEqual(["completed.mp4", "existing.mp4"]);
		expect(await readdir(path.join(workspace, ".render-jobs"))).toEqual([]);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("the profile falls back to the writable workspace when its usual path is inaccessible", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-profile-"));
	const data = path.join(workspace, "data");
	await mkdir(path.join(data, ".render-browser"), { recursive: true });
	const write = fs.writeFile;
	const deny = spyOn(fs, "writeFile").mockImplementation(async (file, ...args) => {
		if (typeof file === "string" && file.startsWith(data)) throw new Error("File creation denied");
		await write(file, ...args);
	});
	try {
		expect(await profileDirectory(workspace, data)).toBe(path.join(workspace, ".render-browser"));
	} finally {
		deny.mockRestore();
		await rm(workspace, { recursive: true, force: true });
	}
});

test("recovery retains the output and journal while the canonical result is unreadable", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-unreadable-"));
	const scratch = path.join(workspace, ".render-jobs", "cli-01234567-0000-0000-0000-012345678901");
	const file = path.join(workspace, "exports", "Protected.mp4");
	const resultFile = path.join(scratch, "export-result.json");
	try {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, "video");
		await recordOutput(workspace, scratch, file, file);
		await mkdir(resultFile); // The result path exists but cannot be read as JSON.
		await expect(recoverRenderJobs(workspace)).rejects.toThrow();
		expect(await readFile(file, "utf8")).toBe("video");
		expect(await readdir(scratch)).toContain("output.json");
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("cancelling a job also cancels a stalled result body", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-stalled-"));
	const controller = new AbortController();
	try {
		const response = await startRender(begin(controller.signal), workspace, async () => "project");
		const claim = await renderRequest(visible(), "export", workspace);
		let cancelled = false;
		const posting = renderWorker(new Request(`${url}?action=export-result`, {
			method: "POST", headers: { [tokenHeader]: claim.headers.get(tokenHeader)! },
			body: new ReadableStream({ cancel() { cancelled = true; } }),
		}), workspace);
		controller.abort();
		expect((await posting).ok).toBe(false);
		await response.text();
		expect(cancelled).toBe(true);
	} finally {
		controller.abort();
		await rm(workspace, { recursive: true, force: true });
	}
}, 1500);

test("renders queue behind the running one and start in turn; a full queue is refused", async () => {
	const workspace = await mkdtemp(path.join(tmpdir(), "agent-render-queue-"));
	const readers: ReadableStreamDefaultReader<string>[] = [];
	const open = async (signal?: AbortSignal) => {
		const response = await startRender(begin(signal), workspace, async () => "project", { grace: 60_000, seen: 60_000 });
		expect(response.ok).toBe(true);
		const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
		readers.push(reader);
		return async () => JSON.parse((await reader.read()).value!);
	};
	try {
		const first = new AbortController();
		const running = await open(first.signal);
		expect(await running()).toEqual({ stage: "waiting for a tab" });
		const second = await open();
		expect((await second()).stage).toBe("waiting in the render queue (1 ahead; the running render is waiting for a tab)");
		const third = await open();
		expect((await third()).stage).toBe("waiting in the render queue (2 ahead; the running render is waiting for a tab)");
		for (let index = 2; index < MAX_RENDER_QUEUE; index++) await open();
		expect((await startRender(begin(), workspace, async () => "project")).status).toBe(409);

		// The running render ends: the second starts as a render of its own, and the third moves up.
		first.abort();
		expect(await second()).toEqual({ stage: "waiting for a tab" });
		expect((await third()).stage).toBe("waiting in the render queue (1 ahead; the running render is waiting for a tab)");
	} finally {
		for (const reader of readers) await reader.cancel().catch(() => {});
		await Bun.sleep(50);
		await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
	}
});
