import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunningBrowser } from "./hidden-browser";
import { handleMcp, type McpOptions } from "./mcp";
import { waitingForRender } from "./render-timeout";

let workspace: string;
let server: ReturnType<typeof Bun.serve>;
/** What the stand-in for the editor's render route answers. */
let respond: (req: Request) => Response = () => new Response(null, { status: 500 });
const posted: { projectId: string | null; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-mcp-jobs-"));
	server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname !== "/api/agent/cli/render" || req.method !== "POST") return new Response(null, { status: 404 });
			posted.push({ projectId: url.searchParams.get("projectId"), body: await req.json() });
			return respond(req);
		},
	});
});
afterAll(async () => {
	server.stop(true);
	await fs.rm(workspace, { recursive: true, force: true });
});

/** A render answer that the test writes line by line. Like the render route, it starts with its first stage. */
function feed() {
	let output!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	const line = (event: object) => new TextEncoder().encode(JSON.stringify(event) + "\n");
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			output = controller;
			controller.enqueue(line({ stage: waitingForRender }));
		},
		cancel() { cancelled = true; },
	});
	return {
		response: () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }),
		send: (event: object) => output.enqueue(line(event)),
		get cancelled() { return cancelled; },
	};
}

const call = async (name: string, args: Record<string, unknown>, options: McpOptions = {}) => {
	const request = new Request(`http://127.0.0.1:${server.port}/api/mcp`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	return (await (await handleMcp(request, workspace, { jobWaitMs: 0, ...options })).json()).result;
};
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

test("export_video renders as a job, and get_job follows it to the video's path", async () => {
	const render = feed();
	respond = () => render.response();
	const started = await call("export_video", { projectId: "demo", name: "Final" });
	expect(started.isError).toBeUndefined();
	const { jobId } = started.structuredContent;
	expect(started.structuredContent).toMatchObject({ kind: "export", projectId: "demo", status: "running" });
	expect(started.structuredContent.message).toContain("Call get_job with this jobId");
	expect(posted.at(-1)).toEqual({ projectId: "demo", body: { command: "export", timeoutMs: 600_000,
		request: { name: "Final", format: "mp4", quality: "very_high", includeAudio: true, allowMissing: false } } });

	render.send({ stage: "encoding 50% (frame 15)" });
	await tick();
	expect((await call("get_job", { jobId, waitSeconds: 0 })).structuredContent).toMatchObject({ status: "running", stage: "encoding 50% (frame 15)" });
	const waited = call("get_job", { jobId, waitSeconds: 5 });
	render.send({ result: { rev: "cli-1", projectId: "demo", status: "done", file: "exports/Final.mp4" } });
	const video = path.join(workspace, "exports", "Final.mp4");
	expect((await waited).structuredContent).toMatchObject({ status: "done", path: video, message: `Exported ${video}.`,
		result: { file: "exports/Final.mp4" } });
});

test("get_frames starts the hidden browser when the route asks, and returns the frames as pictures", async () => {
	const jpeg = (n: number) => Buffer.from([0xff, 0xd8, 0xff, n, 0xff, 0xd9]);
	const folder = path.join(workspace, "frames", "cli-2");
	await fs.mkdir(folder, { recursive: true });
	await fs.writeFile(path.join(folder, "1.jpg"), jpeg(1));
	await fs.writeFile(path.join(folder, "2.jpg"), jpeg(2));
	const render = feed();
	respond = () => render.response();
	const stop = mock(async () => {});
	const launch = mock((_url: string, _profile: string): RunningBrowser => ({ exited: new Promise(() => {}), stop }));
	render.send({ launch: "http://127.0.0.1/agent/render/key", profile: "profile-folder" });
	setTimeout(() => render.send({ result: { rev: "cli-2", projectId: "demo", files: ["frames/cli-2/1.jpg", "frames/cli-2/2.jpg"],
		errors: [{ time: 99, error: "Time outside timeline" }] } }), 100);

	const frames = await call("get_frames", { projectId: "demo", times: [1, 2, 99] }, { launch, jobWaitMs: 5000 });
	expect(launch).toHaveBeenCalledWith("http://127.0.0.1/agent/render/key", "profile-folder");
	expect(stop).toHaveBeenCalled();
	expect(posted.at(-1)!.body).toMatchObject({ command: "frames", request: { times: [1, 2, 99], width: 960, allowMissing: false } });
	expect(frames.isError).toBeUndefined();
	expect(frames.structuredContent).toMatchObject({ status: "done", paths: [path.join(folder, "1.jpg"), path.join(folder, "2.jpg")] });
	expect(frames.structuredContent.message).toBe("Rendered 2 frames; 1 could not be rendered (see result.errors). They are attached as pictures.");
	expect(JSON.parse(frames.content[0].text)).toEqual(frames.structuredContent);
	expect(frames.content.slice(1)).toEqual([1, 2].map((n) => ({ type: "image", data: jpeg(n).toString("base64"), mimeType: "image/jpeg" })));
});

test("a busy render route, a failed render and invalid input come back as tool errors", async () => {
	respond = () => Response.json({ error: "A CLI render is already running." }, { status: 409 });
	expect(await call("export_video", { projectId: "demo" })).toMatchObject({ isError: true, content: [{ text: "A CLI render is already running." }] });
	const count = posted.length;
	expect(await call("export_video", { projectId: "demo", format: "avi" })).toMatchObject({ isError: true, content: [{ text: "format must be one of mp4, webm" }] });
	expect(await call("get_frames", { projectId: "demo" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Use one of") }] });
	expect(await call("get_frames", { projectId: "demo", times: [-1] })).toMatchObject({ isError: true });
	expect(await call("export_video", { projectId: "../demo" })).toMatchObject({ isError: true });
	expect(posted.length).toBe(count);
	expect(await call("get_job", { jobId: "job-missing" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("No job") }] });

	const render = feed();
	respond = () => render.response();
	render.send({ result: { rev: "cli-3", projectId: "demo", status: "error", error: "Encoding failed" } });
	expect(await call("export_video", { projectId: "demo" }, { jobWaitMs: 5000 }))
		.toMatchObject({ isError: true, structuredContent: { status: "failed", message: "The job failed: Encoding failed" } });
});

test("cancel_job stops a running job and its render connection", async () => {
	const render = feed();
	respond = () => render.response();
	const { jobId } = (await call("export_video", { projectId: "demo" })).structuredContent;
	const cancelled = await call("cancel_job", { jobId });
	expect(cancelled.isError).toBeUndefined();
	expect(cancelled.structuredContent).toMatchObject({ jobId, status: "cancelled", message: "The job was cancelled." });
	await tick(200);
	expect(render.cancelled).toBe(true);
	expect((await call("get_job", { jobId, waitSeconds: 0 })).structuredContent.status).toBe("cancelled");
});
