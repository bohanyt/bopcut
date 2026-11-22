import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, dataRoot, readJson } from "@/services/storage/server/files";
import { handleExportFile } from "./export-server";
import { parseExportRequest } from "./export";
import { parseFrameInput } from "./render-input";
import { isForeignOrigin } from "./origin";

type Kind = "export" | "frames";
const json = Response.json;
const tabHeader = "x-bopencut-render-tab";
const tokenHeader = "x-bopencut-render-token";
const revPattern = /^cli-[a-f0-9-]{36}$/;
const presence = new Map<string, number>();
const presenceMs = 6000;

type Job = {
	kind: Kind; rev: string; projectId: string; token: string; launchKey: string;
	request: Record<string, unknown>; scratch: string; signal: AbortSignal;
	owner?: string; offered: boolean; finishing: boolean;
	writes: Set<Promise<Response>>;
	send(event: object): void; finish(result: object): Promise<void>; handoff(): void;
};

let active: Job | undefined;
let reserved = false;

export function renderPresence(req: Request) {
	const job = active;
	const projectId = req.headers.get("x-bopencut-project");
	if (projectId && /^[\w-]{1,128}$/.test(projectId)) {
		const now = Date.now();
		for (const [id, seen] of presence) if (now - seen >= presenceMs) presence.delete(id);
		presence.set(projectId, now);
		if (job?.projectId === projectId && !job.owner && !job.offered) job.handoff();
	}
	return projectId;
}

export async function renderRequest(req: Request, kind: Kind, workspace: string) {
	const job = active;
	const projectId = renderPresence(req);
	const tab = req.headers.get(tabHeader);
	if (job?.kind === kind) {
		if (!tab || projectId !== job.projectId || job.offered || job.signal.aborted ||
			req.headers.get("x-bopencut-ready") !== "1" || (job.owner && job.owner !== tab)) return json(null);
		job.owner = tab;
		return json(job.request, { headers: { [tokenHeader]: job.token, "Cache-Control": "no-store" } });
	}
	const request = await readJson(path.join(workspace, `${kind}-request.json`)).catch(() => null);
	return json(request?.cliJob ? null : request, { headers: { "Cache-Control": "no-store" } });
}

export async function startRender(req: Request, workspace: string, resolveProject: () => Promise<string>) {
	if (reserved) return json({ error: "A CLI render is already running." }, { status: 409 });
	reserved = true;
	let running = false;
	try {
		const { command: kind, request: options, timeoutMs } = await req.json();
		if ((kind !== "export" && kind !== "frames") || !options || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) {
			throw new Error("Invalid render request.");
		}
		const projectId = await resolveProject();
		const rev = `cli-${randomUUID()}`;
		const parsed = kind === "export" ? parseExportRequest({ ...options, rev, projectId }) : parseFrameInput(options);
		if (!parsed || typeof parsed === "string") throw new Error(parsed ?? "Invalid export.");
		if (options.state !== undefined || options.compare !== undefined) throw new Error("For historical or comparison frames, open the editor.");
		const request = { ...parsed, rev, projectId };
		const requestFile = path.join(workspace, `${kind}-request.json`);
		const pending = await readJson(requestFile).catch(() => null);
		const previous = await readJson(path.join(workspace, `${kind}-result.json`)).catch(() => null);
		if (pending?.rev && !pending.cliJob && (pending.rev !== previous?.rev || previous.status === "exporting")) {
			throw new Error(`An existing ${kind} request is pending. Finish it in the editor or clear its request file first.`);
		}
		const jobsDir = path.join(workspace, ".render-jobs");
		await fs.mkdir(jobsDir, { recursive: true });
		if (!(await fs.lstat(jobsDir)).isDirectory()) throw new Error("The render jobs folder must be a directory.");
		for (const entry of await fs.readdir(jobsDir, { withFileTypes: true })) {
			if (entry.isDirectory() && revPattern.test(entry.name)) await fs.rm(path.join(jobsDir, entry.name), { recursive: true, force: true });
		}
		const scratch = path.join(jobsDir, rev);
		await atomicWrite(requestFile, JSON.stringify({ ...request, cliJob: true }));
		const controller = new AbortController();
		const writes = new Set<Promise<Response>>();
		let closed = false;
		let lease: ReturnType<typeof setTimeout>;
		let deadline: ReturnType<typeof setTimeout>;
		let stream: ReadableStreamDefaultController<Uint8Array>;
		const close = () => {
			if (closed) return;
			closed = true;
			controller.abort();
			clearTimeout(lease);
			clearTimeout(deadline);
			req.signal.removeEventListener("abort", close);
			try { stream.close(); } catch { /* Client disconnected. */ }
			void Promise.allSettled(writes).then(async () => {
				await fs.rm(scratch, { recursive: true, force: true });
			}).catch(console.error).finally(() => { active = undefined; reserved = false; });
		};
		const job: Job = {
			kind, projectId, rev, request, scratch, writes, signal: controller.signal,
			token: randomUUID(), launchKey: randomUUID(), offered: false, finishing: false,
			send(event) {
				if (!closed) stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
			},
			async finish(result) {
				await atomicWrite(path.join(workspace, `${kind}-result.json`), JSON.stringify(result, null, 1));
				job.send({ result });
				close();
			},
			handoff() {
				clearTimeout(lease);
				lease = setTimeout(() => {
					if (job.owner || closed) return;
					job.offered = true;
					job.send({ launch: new URL(`/agent/render/${job.launchKey}`, req.url).href, profile: path.join(dataRoot(), ".render-browser") });
				}, Date.now() - (presence.get(projectId) ?? 0) < presenceMs ? presenceMs : 2500);
			},
		};
		active = job;
		const body = new ReadableStream<Uint8Array>({
			start(output) {
				stream = output;
				job.send({ stage: "waiting for a tab" });
				job.handoff();
				deadline = setTimeout(close, timeoutMs + 1000);
				req.signal.addEventListener("abort", close, { once: true });
				if (req.signal.aborted) close();
			},
			cancel: close,
		});
		running = true;
		return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
	} finally {
		if (!running) reserved = false;
	}
}

export async function renderWorker(req: Request, workspace: string) {
	const url = new URL(req.url);
	if (!["localhost", "127.0.0.1"].includes(url.hostname) || isForeignOrigin(req) || req.headers.get("sec-fetch-site") === "cross-site") return json(null, { status: 403 });
	const job = active;
	if (!job || job.signal.aborted) return json(null, { status: 404 });
	if (req.method === "GET" && url.searchParams.get("action") === "watch" && req.headers.get(tokenHeader) === job.token) {
		return new Promise<Response>((resolve) => {
			const close = () => {
				req.signal.removeEventListener("abort", close);
				job.signal.removeEventListener("abort", close);
				resolve(json(null));
			};
			job.signal.addEventListener("abort", close, { once: true });
			req.signal.addEventListener("abort", close, { once: true });
			if (req.signal.aborted) close();
		});
	}
	if (req.method === "GET") {
		if (!job.offered || job.owner || url.searchParams.get("key") !== job.launchKey) return json(null, { status: 404 });
		job.owner = "hidden";
		job.send({ stage: "loading project" });
		return json(job.request, { headers: { [tokenHeader]: job.token, "x-bopencut-render-kind": job.kind, "Cache-Control": "no-store" } });
	}
	if (req.headers.get(tokenHeader) !== job.token || !job.owner || job.finishing) return json(null, { status: 409 });
	const write = publish(job, req, url, workspace);
	job.writes.add(write);
	try { return await write; }
	finally { job.writes.delete(write); }
}

async function publish(job: Job, req: Request, url: URL, workspace: string) {
	const action = url.searchParams.get("action");
	try {
		if (action === "failure" && job.owner === "hidden") {
			const { error } = await req.json();
			await finish({ rev: job.rev, projectId: job.projectId, error, ...(job.kind === "frames" ? { files: [] } : {
				status: "error", tab: job.owner, updatedAt: new Date().toISOString(),
			}) });
			return json({ ok: true });
		}
		if (action === "stage" && job.owner === "hidden") {
			const { stage } = await req.json();
			if (stage === "loading media" || stage === "waiting for graphics") job.send({ stage });
			return json({ ok: true });
		}
		if (job.kind === "export" && action === "export-result") {
			const body = await req.json();
			if (body.rev !== job.rev || body.projectId !== job.projectId) return json(null, { status: 409 });
			if (body.status === "exporting") {
				job.send({ stage: `encoding ${Math.round(Number(body.progress) * 100)}%` });
			} else if (body.status === "release" && job.owner !== "hidden") {
				job.owner = undefined;
				job.token = randomUUID();
				job.handoff();
			} else if (body.status === "error") {
				await finish({ ...body, updatedAt: new Date().toISOString() });
			}
			return json({ ok: true });
		}
		if (job.kind === "export" && action === "export-file" && url.searchParams.get("rev") === job.rev && url.searchParams.get("projectId") === job.projectId) {
			job.finishing = true;
			job.send({ stage: "encoding 100%" });
			job.send({ stage: "saving" });
			try {
				await fs.mkdir(job.scratch, { recursive: true });
				return await handleExportFile(req, workspace, { signal: job.signal, temp: path.join(job.scratch, "video.part"), finish: job.finish });
			} finally {
				job.finishing = false;
			}
		}
		if (job.kind === "frames" && action === "frame") {
			const form = await req.formData();
			const time = form.get("time"), image = form.get("image");
			if (form.get("rev") !== job.rev || typeof time !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(time) ||
				!(image instanceof File) || image.type !== "image/jpeg" || form.has("variant")) return json({ error: "Invalid frame" }, { status: 400 });
			job.signal.throwIfAborted();
			job.send({ stage: "saving" });
			await atomicWrite(path.join(job.scratch, `${time}.jpg`), new Uint8Array(await image.arrayBuffer()));
			return json({ file: `frames/${job.rev}/${time}.jpg` });
		}
		if (job.kind === "frames" && action === "frames-result") {
			const body = await req.json();
			if (body.rev !== job.rev || body.projectId !== job.projectId) return json(null, { status: 409 });
			if (body.files?.length) {
				job.signal.throwIfAborted();
				const frames = path.join(workspace, "frames");
				await fs.mkdir(frames, { recursive: true });
				if (!(await fs.lstat(frames)).isDirectory()) throw new Error("The frames folder must be a directory.");
				await fs.rename(job.scratch, path.join(frames, job.rev));
			}
			if (body.files?.length) await job.finish(body);
			else await finish(body);
			return json({ ok: true });
		}
		return json({ error: "This action does not belong to the render job." }, { status: 403 });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
	}

	async function finish(result: object) {
		job.signal.throwIfAborted();
		job.finishing = true;
		try { await job.finish(result); }
		catch (error) { job.finishing = false; throw error; }
	}
}
