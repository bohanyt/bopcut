import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseExportRequest } from "./export";
import type { launchBrowser } from "./hidden-browser";
import { fileInside } from "./inside";
import { renderFailed, runRender } from "./render-client";
import { parseFrameInput } from "./render-input";
import { waitingForRender } from "./render-timeout";

/**
 * Exports and frames of the MCP server run as jobs of this server. A tool starts one and answers after
 * a short wait, with the result or the job's ID, and get_job reads it later, so no call blocks for minutes.
 * They use the render route as the CLI does: an open editor tab renders, or a hidden browser this server starts.
 */

type Args = Record<string, unknown>;
export type JobContext = {
	origin: string;
	workspace: string;
	signal: AbortSignal;
	launch: typeof launchBrowser;
	/** How long export_video and get_frames wait before they answer with the job's ID. */
	jobWaitMs: number;
};
type Kind = "export" | "frames";
type Job = {
	id: string; kind: Kind; projectId: string; startedAt: number; finishedAt?: number; stage: string;
	status: "running" | "done" | "failed" | "cancelled"; result?: Record<string, unknown>; error?: string;
	controller: AbortController; finished: Promise<void>;
};
export type JobAnswer = { value: Record<string, unknown>; isError?: boolean; pictures?: string[] };

const jobs = new Map<string, Job>();
const KEEP_FINISHED = 20;
/** A stage that has not moved on for this long stops the job, as the CLI's default --timeout does. */
const STALL_MS = 600_000;
export const MAX_JOB_WAIT_SECONDS = 50;
/** Frames also come back as pictures for the client to look at, up to this many and this size each. */
const MAX_PICTURES = 8;
const MAX_PICTURE_BYTES = 4 * 1024 * 1024;

function prune() {
	const finished = [...jobs.values()].filter((job) => job.finishedAt !== undefined).sort((a, b) => a.finishedAt! - b.finishedAt!);
	for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) jobs.delete(job.id);
}

async function startJob(kind: Kind, projectId: string, request: Args, context: JobContext): Promise<Job> {
	const controller = new AbortController();
	const target = new URL("/api/agent/cli/render", context.origin);
	target.searchParams.set("projectId", projectId);
	const response = await fetch(target, {
		method: "POST", cache: "no-store", redirect: "error", signal: controller.signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ command: kind, request, timeoutMs: STALL_MS }),
	}).catch(() => {
		throw new Error(`Cannot reach the render route of the editor at ${context.origin}.`);
	});
	if (!response.ok || !response.body) {
		const body = await response.json().catch(() => null);
		throw new Error(body?.error ?? `The editor answered ${response.status}.`);
	}
	const job: Job = {
		id: `job-${randomUUID()}`, kind, projectId, startedAt: Date.now(), stage: waitingForRender, status: "running",
		controller, finished: Promise.resolve(),
	};
	job.finished = runRender(response, {
		signal: controller.signal, timeoutMs: STALL_MS, launch: context.launch,
		progress: (stage) => { job.stage = stage; },
	}).then((result) => {
		job.result = result;
		job.status = renderFailed(kind, result) ? "failed" : "done";
		if (job.status === "failed") job.error = String(result.error ?? "No requested frame could be rendered.");
	}, (error) => {
		if (job.status !== "running") return;
		job.status = "failed";
		job.error = error instanceof Error ? error.message : String(error);
	}).finally(() => {
		job.finishedAt = Date.now();
		prune();
	});
	jobs.set(job.id, job);
	return job;
}

async function waitFor(job: Job, ms: number, signal: AbortSignal) {
	if (ms > 0) await Promise.race([job.finished, sleep(ms, undefined, { signal }).catch(() => {})]);
}

/** A workspace path of a result as an absolute path, for the client to open. */
const absolute = (workspace: string, file: unknown) => typeof file === "string" ? path.resolve(workspace, ...file.split("/")) : null;

async function describe(job: Job, workspace: string): Promise<JobAnswer> {
	const value: Args = {
		jobId: job.id, kind: job.kind, projectId: job.projectId, status: job.status, stage: job.stage,
		seconds: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000),
	};
	const result = job.result;
	if (job.status === "running") {
		value.message = `The ${job.kind === "export" ? "export" : "frames"} job is ${job.stage}. Call get_job with this jobId for its result.`;
		return { value };
	}
	if (result) value.result = result;
	if (job.status !== "done" || !result) {
		value.message = job.status === "cancelled" ? "The job was cancelled." : `The job failed: ${job.error}`;
		return { value, isError: job.status === "failed" };
	}
	if (job.kind === "export") {
		value.path = absolute(workspace, result.file);
		value.message = `Exported ${value.path}.`;
		return { value };
	}
	const files = Array.isArray(result.files) ? result.files.filter((file): file is string => typeof file === "string") : [];
	value.paths = files.map((file) => absolute(workspace, file));
	const pictures: string[] = [];
	for (const file of files.slice(0, MAX_PICTURES)) {
		const found = await fileInside(workspace, ...file.split("/")).catch(() => null);
		const stat = found && await fs.stat(found).catch(() => null);
		if (found && stat && stat.size <= MAX_PICTURE_BYTES) pictures.push((await fs.readFile(found)).toString("base64"));
	}
	const errors = Array.isArray(result.errors) ? result.errors.length : 0;
	value.message = `Rendered ${files.length} frame${files.length === 1 ? "" : "s"}${errors ? `; ${errors} could not be rendered (see result.errors)` : ""}. ` +
		(pictures.length < files.length ? `The first ${pictures.length} are attached as pictures.` : "They are attached as pictures.");
	return { value, pictures };
}

export async function exportVideo(args: Args, projectId: string, context: JobContext): Promise<JobAnswer> {
	const parsed = parseExportRequest({ rev: "mcp", name: args.name, format: args.format, quality: args.quality, fps: args.fps, allowMissing: args.allowMissing });
	if (!parsed || typeof parsed === "string") throw new Error(parsed ?? "Invalid export.");
	const { rev: _rev, ...request } = parsed;
	const job = await startJob("export", projectId, request, context);
	await waitFor(job, context.jobWaitMs, context.signal);
	return describe(job, context.workspace);
}

export async function renderFrames(args: Args, projectId: string, context: JobContext): Promise<JobAnswer> {
	const request = parseFrameInput({ times: args.times, elements: args.elements, noteId: args.noteId, sceneId: args.sceneId,
		width: args.width, allowMissing: args.allowMissing });
	const job = await startJob("frames", projectId, request, context);
	await waitFor(job, context.jobWaitMs, context.signal);
	return describe(job, context.workspace);
}

function findJob(args: Args): Job {
	const job = typeof args.jobId === "string" ? jobs.get(args.jobId) : undefined;
	if (!job) throw new Error("No job with this jobId. Jobs are kept while the editor server runs; a restart forgets them.");
	return job;
}

export async function jobStatus(args: Args, context: JobContext): Promise<JobAnswer> {
	const job = findJob(args);
	const { waitSeconds } = args;
	if (waitSeconds !== undefined && (typeof waitSeconds !== "number" || !(waitSeconds >= 0 && waitSeconds <= MAX_JOB_WAIT_SECONDS))) {
		throw new Error(`Pass waitSeconds from 0 to ${MAX_JOB_WAIT_SECONDS}.`);
	}
	await waitFor(job, waitSeconds === undefined ? context.jobWaitMs : waitSeconds * 1000, context.signal);
	return describe(job, context.workspace);
}

export async function cancelJob(args: Args, context: JobContext): Promise<JobAnswer> {
	const job = findJob(args);
	if (job.status === "running") {
		job.status = "cancelled";
		job.controller.abort(new Error("Cancelled by the MCP client."));
		await job.finished;
	}
	return describe(job, context.workspace);
}
