import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, readJson } from "@/services/storage/server/files";
import { CLAIM_MS, handleExportFile } from "./export-server";
import { parseExportRequest } from "./export";
import { parseFrameInput } from "./render-input";
import { renderTimeoutMessage, waitingForRender } from "./render-timeout";
import { isForeignOrigin } from "./origin";
import { profileDirectory, recordOutput, recoverRenderJobs, removeRenderJob, renderJobDir, rollbackOutput } from "./render-output";

type Kind = "export" | "frames";
const json = Response.json;
const tabHeader = "x-bopencut-render-tab";
const tokenHeader = "x-bopencut-render-token";
const presence = new Map<string, number>();
const presenceMs = 6000;

type Job = {
	kind: Kind; rev: string; projectId: string; token: string; launchKey: string;
	request: Record<string, unknown>; scratch: string; signal: AbortSignal;
	owner?: string; offered: boolean; finishing: boolean;
	framesPromoted: boolean;
	lease: AbortController;
	writes: Set<Promise<Response>>;
	send(event: object): void; finish(result: object, signal: AbortSignal): Promise<void>;
	reportStage(stage: string): void;
	heartbeat(): void; abandon(token: string): void;
	awaitWatch(): void; watchRegistered(): void;
};

let active: Job | undefined;
let reserved = false;
const requestBody = (req: Request, signal: AbortSignal) =>
	new Response(req.body?.pipeThrough(new TransformStream(), { signal }), { headers: req.headers });

export function renderPresence(req: Request) {
	const job = active;
	const projectId = req.headers.get("x-bopencut-project");
	if (projectId && /^[\w-]{1,128}$/.test(projectId)) {
		const now = Date.now();
		for (const [id, seen] of presence) if (now - seen >= presenceMs) presence.delete(id);
		presence.set(projectId, now);
		if (job?.projectId === projectId && job.owner && job.owner === req.headers.get(tabHeader)) job.heartbeat();
	}
	return projectId;
}

export async function renderRequest(req: Request, kind: Kind, workspace: string) {
	const job = active;
	const projectId = renderPresence(req);
	const tab = req.headers.get(tabHeader);
	if (job?.kind === kind && tab && projectId === job.projectId && !job.offered && !job.signal.aborted && !job.lease.signal.aborted &&
		req.headers.get("x-bopencut-ready") === "1" && (!job.owner || job.owner === tab)) {
		job.owner = tab;
		job.heartbeat();
		return json(job.request, { headers: { [tokenHeader]: job.token, "Cache-Control": "no-store" } });
	}
	const request = await readJson(path.join(workspace, `${kind}-request.json`)).catch(() => null);
	return json(request, { headers: { "Cache-Control": "no-store" } });
}

export async function startRender(req: Request, workspace: string, resolveProject: () => Promise<string>,
	{ grace = 2500, seen = presenceMs, claim = CLAIM_MS, watchRegistration = 5000, profileRoot }: {
		grace?: number; seen?: number; claim?: number; watchRegistration?: number; profileRoot?: string;
	} = {}) {
	if (reserved) return json({ error: "A CLI render is already running." }, { status: 409 });
	reserved = true;
	let running = false;
	try {
		const handshake = AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]);
		const { command: kind, request: options, timeoutMs } = await requestBody(req, handshake).json();
		if ((kind !== "export" && kind !== "frames") || !options || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) {
			throw new Error("Invalid render request.");
		}
		const projectId = await resolveProject();
		const rev = `cli-${randomUUID()}`;
		const parsed = kind === "export" ? parseExportRequest({ ...options, rev, projectId }) : parseFrameInput(options);
		if (!parsed || typeof parsed === "string") throw new Error(parsed ?? "Invalid export.");
		if (options.state !== undefined || options.compare !== undefined) throw new Error("For historical or comparison frames, open the editor.");
		const request = { ...parsed, rev, projectId };
		await recoverRenderJobs(workspace);
		const scratch = renderJobDir(workspace, rev);
		try {
			await atomicWrite(path.join(scratch, `${kind}-request.json`), JSON.stringify(request));
		} catch (error) {
			await removeRenderJob(workspace, scratch).catch(console.error);
			throw error;
		}
		const controller = new AbortController();
		const writes = new Set<Promise<Response>>();
		let closed = false;
		let handoff: ReturnType<typeof setTimeout>;
		let expiry: ReturnType<typeof setTimeout>;
		let registration: ReturnType<typeof setTimeout>;
		let deadline: ReturnType<typeof setTimeout>;
		let stage: string;
		let stream: ReadableStreamDefaultController<Uint8Array>;
		let cleanup: Promise<void> | undefined;
		const close = () => {
			if (closed) return cleanup;
			closed = true;
			controller.abort();
			clearTimeout(handoff);
			clearTimeout(expiry);
			clearTimeout(registration);
			clearTimeout(deadline);
			req.signal.removeEventListener("abort", close);
			cleanup = Promise.allSettled(writes).then(() => removeRenderJob(workspace, scratch)).catch(console.error).finally(() => {
				active = undefined;
				reserved = false;
				try { stream.close(); } catch { /* Client disconnected. */ }
			});
			return cleanup;
		};
		const offer = async () => {
			if (job.owner || closed || job.offered) return;
			job.offered = true;
			try {
				const profile = await profileDirectory(workspace, profileRoot);
				job.send({ launch: new URL(`/agent/render/${job.launchKey}`, req.url).href, profile });
			} catch {
				job.send({ result: { rev, projectId, error: "Could not prepare a writable browser profile. Open the editor once and retry." } });
				close();
			}
		};
		const job: Job = {
			kind, projectId, rev, request, scratch, writes, signal: controller.signal,
			token: randomUUID(), launchKey: randomUUID(), offered: false, finishing: false, lease: new AbortController(),
			framesPromoted: false,
			send(event) {
				if (!closed) stream.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
			},
			reportStage(next) {
				if (closed || next === stage) return;
				stage = next;
				clearTimeout(deadline);
				deadline = setTimeout(() => {
					job.send({ result: { rev, projectId, error: renderTimeoutMessage(timeoutMs, stage) } });
					close();
				}, timeoutMs);
				job.send({ stage });
			},
			async finish(result, signal) {
				await atomicWrite(path.join(scratch, `${kind}-result.json`), JSON.stringify(result, null, 1), signal);
				job.send({ result });
				close();
			},
			awaitWatch() {
				registration = setTimeout(() => {
					job.send({ result: { rev, projectId, error: "The hidden browser did not register its render connection." } });
					close();
				}, watchRegistration);
			},
			watchRegistered() {
				clearTimeout(registration);
			},
			heartbeat() {
				clearTimeout(expiry);
				const token = job.token;
				expiry = setTimeout(() => job.abandon(token), claim);
			},
			abandon(token) {
				if (closed || job.lease.signal.aborted || !job.owner || token !== job.token) return;
				if (job.owner === "hidden") {
					job.send({ result: { rev, projectId, error: "The hidden browser lost its render connection before delivering a result." } });
					close();
					return;
				}
				clearTimeout(expiry);
				clearTimeout(handoff);
				job.lease.abort();
				job.token = randomUUID();
				// Keep the old owner fenced out until all of its writes have stopped.
				void Promise.allSettled(writes).then(async () => {
					if (closed) return;
					await rollbackOutput(workspace, scratch);
					job.framesPromoted = false;
					await fs.rm(path.join(scratch, "frames"), { recursive: true, force: true, maxRetries: 3 });
					job.owner = undefined;
					job.lease = new AbortController();
					await offer();
				}).catch(() => close());
			},
		};
		active = job;
		const body = new ReadableStream<Uint8Array>({
			start(output) {
				stream = output;
				job.reportStage(waitingForRender);
				const recentlySeen = Date.now() - (presence.get(projectId) ?? 0) < presenceMs;
				handoff = setTimeout(() => void offer(), recentlySeen ? seen : grace);
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
	const leaseSignal = AbortSignal.any([job.signal, job.lease.signal]);
	if (req.method === "GET" && url.searchParams.get("action") === "watch" && req.headers.get(tokenHeader) === job.token) {
		return new Promise<Response>((resolve) => {
			const token = job.token;
			const disconnect = () => { job.abandon(token); close(); };
			const close = () => {
				req.signal.removeEventListener("abort", disconnect);
				leaseSignal.removeEventListener("abort", close);
				resolve(json(null));
			};
			leaseSignal.addEventListener("abort", close, { once: true });
			req.signal.addEventListener("abort", disconnect, { once: true });
			if (req.signal.aborted) disconnect();
			else if (job.owner === "hidden") job.watchRegistered();
		});
	}
	if (req.method === "GET") {
		if (!job.offered || job.owner || url.searchParams.get("key") !== job.launchKey) return json(null, { status: 404 });
		job.owner = "hidden";
		job.awaitWatch();
		job.reportStage("loading project");
		return json(job.request, { headers: { [tokenHeader]: job.token, "x-bopencut-render-kind": job.kind, "Cache-Control": "no-store" } });
	}
	if (req.headers.get(tokenHeader) !== job.token || !job.owner || job.finishing || leaseSignal.aborted) return json(null, { status: 409 });
	const write = publish(job, req, url, workspace, leaseSignal);
	job.writes.add(write);
	try { return await write; }
	finally { job.writes.delete(write); }
}

async function publish(job: Job, req: Request, url: URL, workspace: string, signal: AbortSignal) {
	const action = url.searchParams.get("action");
	const body = () => requestBody(req, signal);
	try {
		if (action === "failure" && job.owner === "hidden") {
			const { error } = await body().json();
			if (job.finishing) return json(null, { status: 409 });
			await finish({ rev: job.rev, projectId: job.projectId, error, ...(job.kind === "frames" ? { files: [] } : {
				status: "error", tab: job.owner, updatedAt: new Date().toISOString(),
			}) });
			return json({ ok: true });
		}
		if (action === "stage") {
			const { stage } = await body().json();
			signal.throwIfAborted();
			if (job.finishing) return json(null, { status: 409 });
			const startup = job.owner === "hidden" && (stage === "loading media" || stage === "waiting for graphics");
			const valid = typeof stage === "string" && (job.kind === "export"
				? stage === "mixing audio" || stage === "starting encoding" || stage === "finalizing video" || /^checking video \d{1,12}\/\d{1,12}$/.test(stage)
				: /^rendering frame \d{1,3}\/\d{1,3}$/.test(stage));
			if (startup || valid) job.reportStage(stage);
			return json({ ok: true });
		}
		if (job.kind === "export" && action === "export-result") {
			const result = await body().json();
			signal.throwIfAborted();
			if (job.finishing || result.rev !== job.rev || result.projectId !== job.projectId) return json(null, { status: 409 });
			if (result.status === "exporting") {
				if (job.owner !== "hidden") job.heartbeat();
				const percent = Math.round(Number(result.progress) * 100);
				if (percent >= 0 && percent <= 100) {
					const frame = Number.isSafeInteger(result.frame) && result.frame > 0 ? ` (frame ${result.frame})` : "";
					job.reportStage(`encoding ${percent}%${frame}`);
				}
			} else if (result.status === "release" && job.owner !== "hidden") {
				job.abandon(job.token);
			} else if (result.status === "error") {
				await finish({ ...result, updatedAt: new Date().toISOString() });
			}
			return json({ ok: true });
		}
		if (job.kind === "export" && action === "export-file" && url.searchParams.get("rev") === job.rev && url.searchParams.get("projectId") === job.projectId) {
			job.finishing = true;
			job.reportStage("uploading video");
			try {
				await fs.mkdir(job.scratch, { recursive: true });
				return await handleExportFile(req, workspace, {
					signal, temp: path.join(job.scratch, "video.part"),
					onUpload: (bytes) => job.reportStage(`uploading video (${bytes} bytes)`),
					beforePublish: (target, source) => {
						job.reportStage("saving video");
						return recordOutput(workspace, job.scratch, target, source);
					},
					finish: (result) => job.finish(result, signal),
				});
			} catch (error) {
				await rollbackOutput(workspace, job.scratch);
				throw error;
			} finally {
				job.finishing = false;
			}
		}
		if (job.kind === "frames" && action === "frame") {
			const form = await body().formData();
			if (job.finishing || job.framesPromoted) return json(null, { status: 409 });
			const time = form.get("time"), image = form.get("image");
			if (form.get("rev") !== job.rev || typeof time !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(time) ||
				!(image instanceof File) || image.type !== "image/jpeg" || form.has("variant")) return json({ error: "Invalid frame" }, { status: 400 });
			signal.throwIfAborted();
			if (job.owner !== "hidden") job.heartbeat();
			job.reportStage("saving");
			await atomicWrite(path.join(job.scratch, "frames", `${time}.jpg`), new Uint8Array(await image.arrayBuffer()), signal);
			return json({ file: `frames/${job.rev}/${time}.jpg` });
		}
		if (job.kind === "frames" && action === "frames-result") {
			const result = await body().json();
			if (result.rev !== job.rev || result.projectId !== job.projectId) return json(null, { status: 409 });
			if (job.finishing) return json(null, { status: 409 });
			signal.throwIfAborted();
			job.finishing = true;
			try {
				if (result.files?.length && !job.framesPromoted) {
					const frames = path.join(workspace, "frames");
					await fs.mkdir(frames, { recursive: true });
					if (!(await fs.lstat(frames)).isDirectory()) throw new Error("The frames folder must be a directory.");
					const source = path.join(job.scratch, "frames");
					const target = path.join(frames, job.rev);
					await recordOutput(workspace, job.scratch, target, source);
					signal.throwIfAborted();
					await fs.rename(source, target);
					job.framesPromoted = true;
				}
				await job.finish(result, signal);
			} finally {
				job.finishing = false;
			}
			return json({ ok: true });
		}
		return json({ error: "This action does not belong to the render job." }, { status: 403 });
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
	}

	async function finish(result: object) {
		signal.throwIfAborted();
		job.finishing = true;
		try { await job.finish(result, signal); }
		catch (error) { job.finishing = false; throw error; }
	}
}
