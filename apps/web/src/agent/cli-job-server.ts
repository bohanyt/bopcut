import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, dataRoot, projectDir, readJson, removeMedia, safeId, withProjectLock } from "@/services/storage/server/files";
import { mediaIdsInScenes } from "@/media/project-media";
import { AgentJobs, type AgentJob, type JobBody } from "./cli-jobs";

type DraftRecovery = { projectId: string; staged: string[]; words: [string, unknown][] };

const globals = globalThis as typeof globalThis & { bopencutAgentJobs?: AgentJobs; bopencutAgentRecovery?: Map<string, Promise<void>> };
const recovered = globals.bopencutAgentRecovery ??= new Map();
const recoveryDir = () => path.join(dataRoot(), ".agent-jobs");
const recoveryFile = (jobId: string) => path.join(recoveryDir(), safeId(jobId) + ".recovery");

export async function rememberDraft(job: AgentJob) {
	const data: DraftRecovery = { projectId: job.projectId, staged: [...job.staged], words: [...job.words] };
	await atomicWrite(recoveryFile(job.id), JSON.stringify(data));
}

async function rollbackDraft(jobId: string, { projectId, staged, words }: DraftRecovery) {
	await withProjectLock(projectId, async () => {
		const dir = projectDir(projectId);
		const project = await readJson(path.join(dir, "project.json"));
		if (!project) return;
		const committed = project.agentJob === jobId;
		const used = committed ? mediaIdsInScenes(project.scenes ?? []) : new Set<string>();
		for (const id of staged) {
			if (used.has(id)) continue;
			await removeMedia(projectId, safeId(id), { interruptedUpload: true });
		}
		if (committed) return;
		for (const [id, previous] of words) {
			const file = path.join(dir, "media", "_metadata", safeId(id) + ".json");
			const current = await readJson(file);
			if (current) await atomicWrite(file, JSON.stringify({ ...current, words: previous ?? undefined }));
		}
	});
}

export function recoverAgentJobs() {
	const root = recoveryDir();
	const existing = recovered.get(root);
	if (existing) return existing;
	const scan = (async () => {
		const files = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		});
		for (const name of files) {
			const match = /^([a-zA-Z0-9_-]{1,128})\.(recovery|json)$/.exec(name);
			if (!match) continue;
			const file = path.join(root, name);
			if (match[2] === "recovery") {
				const data: DraftRecovery | null = await readJson(file);
				if (data) await rollbackDraft(match[1], data);
			}
			await fs.rm(file, { force: true });
		}
	})();
	recovered.set(root, scan);
	void scan.catch(() => recovered.delete(root));
	return scan;
}
export const agentJobs = globals.bopencutAgentJobs ??= new AgentJobs(async (job) => {
	if (job.resultFile) await fs.rm(job.resultFile, { force: true });
	if (!job.update.done && job.frameFiles.size) {
		await Promise.all([...job.frameFiles].map((file) => fs.rm(file, { force: true })));
		const [file] = job.frameFiles;
		await fs.rmdir(path.dirname(file));
	}
	if (job.hidden && job.command === "draft" && (job.staged.size || job.words.size)) {
		if (!job.committed || !job.update.done) await rollbackDraft(job.id, { projectId: job.projectId, staged: [...job.staged], words: [...job.words] });
		await fs.rm(recoveryFile(job.id), { force: true });
	}
});

export class JobError extends Error {
	constructor(message: string, readonly status = 400) { super(message); }
}

export function getJob(id: string) {
	const job = agentJobs.active;
	if (!job || job.id !== id || job.signal.aborted) throw new JobError("The agent job ended or the server restarted. Check the project before retrying.", 410);
	return job;
}

export async function finishJob(job: AgentJob, body: JobBody) {
	job.signal.throwIfAborted();
	if (job.update.done) return;
	const file = path.join(dataRoot(), ".agent-jobs", job.id + ".json");
	job.resultFile = file;
	await atomicWrite(file, JSON.stringify({ ...body, rev: job.body.rev, projectId: job.projectId }));
	job.signal.throwIfAborted();
	job.progress(job.update.stage, job.update.percent, true);
}

export async function waitForJob(job: AgentJob, version: number, signal: AbortSignal) {
	const update = await job.wait(version, signal);
	if (job.signal.aborted) throw new JobError("The agent job expired. Check the project before retrying.", 410);
	return { ...update, ...(update.done && job.resultFile ? { result: await readJson(job.resultFile) } : {}) };
}

let syncWrites: Promise<unknown> = Promise.resolve();

export function writeWorkspaceSnapshot(workspace: string, body: JobBody, hidden = false) {
	const writing = syncWrites.then(async () => {
		const text = JSON.stringify(body, null, 1);
		const safe = String(body.projectId ?? "tanpa-id").replace(/[^a-zA-Z0-9_-]/g, "");
		await atomicWrite(path.join(workspace, "sync", `${safe}.json`), text);
		const last = path.join(workspace, "project.json");
		const lastProject = hidden ? await readJson(last) : null;
		if (!hidden || lastProject?.projectId === body.projectId) await atomicWrite(last, text);
	});
	syncWrites = writing.catch(() => {});
	return writing;
}

export async function snapshotFor(workspace: string, projectId?: string) {
	return readJson(projectId ? path.join(workspace, "sync", projectId + ".json") : path.join(workspace, "project.json")) as Promise<JobBody | null>;
}

export function editorPresence(req: Request, projectId: string, tab: string) {
	const unregister = agentJobs.register(projectId, tab);
	const close = () => {
		unregister();
		req.signal.removeEventListener("abort", close);
	};
	return new Response(new ReadableStream({
		async start(controller) {
			req.signal.addEventListener("abort", close, { once: true });
			if (req.signal.aborted) return close();
			await agentJobs.beforeOpen(projectId);
			if (!req.signal.aborted) controller.enqueue(new TextEncoder().encode("event: registered\ndata: {}\n\n"));
		},
		cancel: close,
	}), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform" } });
}

export async function checkProjectExists(projectId: string) {
	try { await fs.access(path.join(projectDir(projectId), "project.json")); }
	catch { throw new JobError("Project was not found on disk. Open the project in the editor once or pass a valid --project-id.", 404); }
}
