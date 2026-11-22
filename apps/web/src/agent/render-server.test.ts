import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderPresence, renderRequest, renderWorker, startRender } from "./render-server";
import { profileDirectory, recordOutput, recoverRenderJobs } from "./render-output";

const url = "http://127.0.0.1/api/agent/cli/render";
const tokenHeader = "x-bopencut-render-token";
const begin = (signal?: AbortSignal) => new Request(url, {
	signal, method: "POST", body: JSON.stringify({ command: "export", request: {}, timeoutMs: 10000 }),
});
const visible = (project = "project") => new Request(url, { headers: {
	"x-bopencut-project": project, "x-bopencut-render-tab": "visible", "x-bopencut-ready": "1",
} });

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
			expect((await startRender(begin(), workspace, async () => "project")).status).toBe(409);
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
			const post = (action: string, body: object) => renderWorker(new Request(`${url}?action=${action}`, {
				method: "POST", headers: { [tokenHeader]: token }, body: JSON.stringify(body),
			}), workspace);
			for (const action of ["draft", "applied", "sync", "selection", "edits", "retrieve", "gif"]) {
				expect((await post(action, {})).status).toBe(403);
			}
			await post("export-result", { rev: request.rev, projectId: "project", status: "exporting", progress: 0.42 });
			expect(await next()).toEqual({ stage: "encoding 42%" });
			expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ rev: "legacy", status: "done" });
			const query = new URLSearchParams({ action: "export-file", rev: request.rev, projectId: "project", name: "Final", format: "mp4", result: '{"format":"mp4","fps":30}' });
			const saved = renderWorker(new Request(`${url}?${query}`, {
				method: "POST", headers: { [tokenHeader]: token }, body: "video",
			}), workspace);
			expect(await next()).toEqual({ stage: "encoding 100%" });
			expect(await next()).toEqual({ stage: "saving" });
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
		await reader.read(); // encoding 100%
		await reader.read(); // saving
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
			expect(JSON.parse((await reader.read()).value!)).toEqual({ stage: "loading project" });
			expect(JSON.parse((await reader.read()).value!)).toEqual({ stage: "saving" });
			expect(JSON.parse((await reader.read()).value!)).toEqual({ result });
			expect(await reader.read()).toMatchObject({ done: true });
			expect(await readFile(path.join(workspace, file), "utf8")).toBe("jpeg");
		} else {
			controller.abort();
			expect(JSON.parse((await reader.read()).value!)).toEqual({ stage: "loading project" });
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
			rev, projectId, error: "The hidden browser did not register its render connection.",
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
		for (const [index, name] of ["abandoned", "completed", "existing"].entries()) {
			const rev = `cli-01234567-0000-0000-0000-01234567890${index}`;
			const scratch = path.join(workspace, ".render-jobs", rev);
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
