import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, readJson } from "@/services/storage/server/files";
import { CLAIM_MS, handleExportFile } from "./export-server";
import { parseExportRequest } from "./export";
import { parseFrameInput } from "./render-input";
import { MAX_RANGE_PNG, parseRangeInput } from "./range-view";
import { isReviewRunning } from "./review-activity";
import { renderTimeoutMessage, waitingForGraphics, waitingForRender } from "./render-timeout";
import { isRenderAdapterStage, renderGpuWorkaround } from "./render-gpu";
import { isForeignOrigin } from "./origin";
import { profileDirectory, recordOutput, recoverRenderJobs, removeRenderJob, renderJobDir, rollbackOutput } from "./render-output";

type Kind = "export" | "frames" | "view";
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
	reportStage(stage: string, sequence?: number): void;
	heartbeat(): void; abandon(token: string): void;
	awaitWatch(): void; watchRegistered(): void;
};

let active: Job | undefined;
let reserved = false;
export const isCliRenderRunning = () => reserved;

/** How many CLI renders may wait for the one that runs. */
export const MAX_RENDER_QUEUE = 8;
type Waiting = { grant(): void; update(stage: string): void };
/** Renders that wait for the running one, first come first served. */
const queue: Waiting[] = [];
let runningStage: string | undefined;
/** Tells every waiting render its place and what the running one does, so its own timeout keeps counting progress. */
function announceQueue() {
	queue.forEach((waiting, index) => waiting.update(
		`waiting in the render queue (${index + 1} ahead${runningStage ? `; the running render is ${runningStage}` : ""})`));
}
/** Ends the running render's hold: the next waiting render starts, or the slot is free. */
function release() {
	runningStage = undefined;
	const next = queue.shift();
	if (!next) {
		reserved = false;
		return;
	}
	// The next render announces the new places when it reports its first stage.
	next.grant();
}
const requestBody = (req: Request, signal: AbortSignal) =>
	new Response(req.body?.pipeThrough(new TransformStream(), { signal }), { headers: req.headers });

/** Whether an editor tab of the project asked for agent requests in the last few seconds (it asks every 2 s). */
export const isProjectOpen = (projectId: string) => Date.now() - (presence.get(projectId) ?? -Infinity) < presenceMs;

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

export async function renderRequest(req: Request, kind: Exclude<Kind, "view">, workspace: string) {
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

type RenderOptions = { grace?: number; seen?: number; claim?: number; watchRegistration?: number; profileRoot?: string };

/**
 * Starts a CLI render, or puts it in the queue behind the one that runs: the queued render's stream
 * reports its place until its turn comes, then carries the render as if it had started then.
 */
export async function startRender(req: Request, workspace: string, resolveProject: () => Promise<string>, options: RenderOptions = {}) {
	if (isReviewRunning()) return json({ error: "An export review is running." }, { status: 409 });
	if (!reserved) {
		reserved = true;
		return beginRender(req, workspace, resolveProject, options);
	}
	if (queue.length >= MAX_RENDER_QUEUE) return json({ error: `The render queue is full (${MAX_RENDER_QUEUE} waiting). Retry later.` }, { status: 409 });
	let body: string;
	try {
		body = await requestBody(req, AbortSignal.any([req.signal, AbortSignal.timeout(10_000)])).text();
	} catch {
		return json({ error: "Invalid render request." }, { status: 400 });
	}
	let output!: ReadableStreamDefaultController<Uint8Array>;
	let done = false;
	const send = (event: object) => {
		if (!done) output.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
	};
	const finish = () => {
		if (done) return;
		done = true;
		const index = queue.indexOf(waiting);
		if (index >= 0) {
			queue.splice(index, 1);
			announceQueue();
		}
		try { output.close(); } catch { /* Client disconnected. */ }
	};
	let last: string | undefined;
	const waiting: Waiting = {
		update(stage) {
			if (stage === last) return;
			last = stage;
			send({ stage });
		},
		async grant() {
			if (done || req.signal.aborted) {
				done = true;
				release();
				return;
			}
			const started = await beginRender(new Request(req.url, { method: "POST", headers: req.headers, body, signal: req.signal }),
				workspace, resolveProject, options);
			if (!started.ok || !started.body) {
				const answer = await started.json().catch(() => null);
				send({ result: { error: answer?.error ?? "The render did not start." } });
				finish();
				return;
			}
			const reader = started.body.getReader();
			try {
				for (;;) {
					const { value, done: ended } = await reader.read();
					if (ended || done) break;
					output.enqueue(value);
				}
			} catch { /* The render closed its stream. */ }
			finish();
		},
	};
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			output = controller;
			queue.push(waiting);
			announceQueue();
			req.signal.addEventListener("abort", finish, { once: true });
		},
		cancel: finish,
	});
	return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}

/** Runs a render that holds the slot (`reserved`); the slot passes on when it ends. */
async function beginRender(req: Request, workspace: string, resolveProject: () => Promise<string>,
	{ grace = 2500, seen = presenceMs, claim = CLAIM_MS, watchRegistration = 5000, profileRoot }: RenderOptions) {
	let running = false;
	try {
		const handshake = AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]);
		const { command: kind, request: options, timeoutMs } = await requestBody(req, handshake).json();
		if ((kind !== "export" && kind !== "frames" && kind !== "view") || !options || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000) {
			throw new Error("Invalid render request.");
		}
		const projectId = await resolveProject();
		const rev = `cli-${randomUUID()}`;
		const parsed = kind === "export" ? parseExportRequest({ ...options, rev, projectId })
			: kind === "view" ? parseRangeInput(options) : parseFrameInput(options);
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
		let stageSequence = 0;
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
				release();
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
			reportStage(next, sequence) {
				if (closed) return;
				// The worker can start a later phase before an earlier report arrives.
				if (sequence !== undefined) {
					if (!Number.isSafeInteger(sequence) || sequence <= stageSequence) return;
					stageSequence = sequence;
				}
				if (next === stage) return;
				stage = next;
				runningStage = next;
				announceQueue();
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
					job.send({ result: { rev, projectId, error: `The hidden browser did not register its render connection. ${renderGpuWorkaround}` } });
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
					const error = "The hidden browser lost its render connection before delivering a result.";
					job.send({ result: { rev, projectId, error: stage === waitingForGraphics ? `${error} ${renderGpuWorkaround}` : error } });
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
					stageSequence = 0;
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
				handoff = setTimeout(() => void offer(), kind === "view" ? 0 : recentlySeen ? seen : grace);
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
		if (!running) release();
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
	const sequence = req.headers.get("x-bopencut-render-stage-sequence");
	const reportStage = (stage: string) => job.reportStage(stage, sequence === null ? undefined : Number(sequence));
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
			const startup = job.owner === "hidden" && (
				stage === "loading media" || stage === waitingForGraphics || isRenderAdapterStage(stage)
			);
			const valid = typeof stage === "string" && (job.kind === "export"
				? stage === "mixing audio" || stage === "starting encoding" || stage === "finalizing video" || /^checking video \d{1,12}\/\d{1,12}$/.test(stage)
				: /^rendering frame \d{1,3}\/\d{1,3}$/.test(stage) || (job.kind === "view" && stage === "mixing range audio"));
			if (startup || valid) reportStage(stage);
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
					reportStage(`encoding ${percent}%${frame}`);
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
			reportStage("uploading video");
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
			const crop = form.get("crop");
			if (form.get("rev") !== job.rev || typeof time !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(time) ||
				!(image instanceof File) || image.type !== "image/jpeg" || form.has("variant")) return json({ error: "Invalid frame" }, { status: 400 });
			if (crop !== null && (!(crop instanceof File) || crop.type !== "image/jpeg" || !job.request.noteId)) return json({ error: "Invalid crop" }, { status: 400 });
			signal.throwIfAborted();
			if (job.owner !== "hidden") job.heartbeat();
			reportStage("saving");
			await atomicWrite(path.join(job.scratch, "frames", `${time}.jpg`), new Uint8Array(await image.arrayBuffer()), signal);
			if (crop instanceof File) {
				await atomicWrite(path.join(job.scratch, "frames", `${time}-crop.jpg`), new Uint8Array(await crop.arrayBuffer()), signal);
				return json({ file: `frames/${job.rev}/${time}.jpg`, crop: `frames/${job.rev}/${time}-crop.jpg` });
			}
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
		if (job.kind === "view" && action === "view-file" && job.owner === "hidden") {
			const length = req.headers.get("content-length");
			const size = length === null ? MAX_RANGE_PNG : Number(length);
			if (!req.body || !Number.isSafeInteger(size) || size < 8 || size > MAX_RANGE_PNG || req.headers.get("content-type") !== "image/png") {
				return json({ error: "Invalid PNG size or type." }, { status: 400 });
			}
			job.finishing = true;
			try {
				reportStage("saving range picture");
				let received = 0;
				const bounded = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, stream) {
						received += chunk.byteLength;
						if (received > size) stream.error(new Error("The PNG upload exceeds its size limit."));
						else stream.enqueue(chunk);
					},
				}), { signal });
				const bytes = new Uint8Array(await new Response(bounded).arrayBuffer());
				if ((length !== null && bytes.length !== size) || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) {
					return json({ error: "Invalid PNG." }, { status: 400 });
				}
				const views = path.join(workspace, "views");
				await fs.mkdir(views, { recursive: true });
				if (!(await fs.lstat(views)).isDirectory()) throw new Error("The views folder must be a directory.");
				const source = path.join(job.scratch, "view.png");
				const target = path.join(views, `${job.rev}.png`);
				await atomicWrite(source, bytes, signal);
				await recordOutput(workspace, job.scratch, target, source);
				signal.throwIfAborted();
				await fs.rename(source, target);
				await job.finish({ rev: job.rev, projectId: job.projectId, file: `views/${job.rev}.png`, bytes: bytes.length, ...parseRangeInput(job.request) }, signal);
				return json({ ok: true });
			} catch (error) {
				await rollbackOutput(workspace, job.scratch);
				throw error;
			} finally {
				job.finishing = false;
			}
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
