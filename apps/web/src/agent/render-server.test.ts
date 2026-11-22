import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderRequest, renderWorker, startRender } from "./render-server";

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
			const response = await startRender(begin(), workspace, async () => "project");
			reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
			const next = async () => JSON.parse((await reader!.read()).value!);
			expect(await next()).toEqual({ stage: "waiting for a tab" });
			expect(await readdir(scratch)).toEqual([]);
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
			expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual(result);
			expect(await readFile(path.join(workspace, result.file), "utf8")).toBe("video");
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
		const upload = renderWorker(new Request(`${url}?${query}`, {
			method: "POST", headers: { [tokenHeader]: claim.headers.get(tokenHeader)! },
			body: new ReadableStream({ start: (body) => body.enqueue(new Uint8Array(1024)) }),
		}), workspace);
		await reader.read(); // encoding 100%
		await reader.read(); // saving
		controller.abort();
		expect((await upload).ok).toBe(false);
		expect(JSON.parse(await readFile(resultPath, "utf8"))).toEqual({ rev: "legacy", status: "done" });
		expect(await readdir(path.join(workspace, "exports")).catch(() => [])).toEqual([]);
	} finally {
		controller.abort();
		await rm(workspace, { recursive: true, force: true });
	}
});
