import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, dataRoot, projectDir, readJson, removeMedia, statFile, withProjectLock } from "@/services/storage/server/files";
import { AgentJobs, type AgentJob, type JobBody } from "./cli-jobs";

const globals = globalThis as typeof globalThis & { bopencutAgentJobs?: AgentJobs };
export const agentJobs = globals.bopencutAgentJobs ??= new AgentJobs(async (job) => {
	if (job.resultFile) await fs.rm(job.resultFile, { force: true });
	if (!job.update.done && job.frameFiles.size) {
		await Promise.all([...job.frameFiles].map((file) => fs.rm(file, { force: true })));
		const [file] = job.frameFiles;
		await fs.rmdir(path.dirname(file));
	}
	if (job.hidden && job.command === "draft" && !job.committed && (job.staged.size || job.words.size)) {
		await withProjectLock(job.projectId, async () => {
			for (const id of job.staged) await removeMedia(job.projectId, id);
			if (await statFile(path.join(projectDir(job.projectId), "project.json"))) {
				for (const [file, previous] of job.words) await atomicWrite(file, JSON.stringify(previous));
			}
		});
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
	job.progress(job.update.stage, job.update.percent, true);
}

export async function waitForJob(job: AgentJob, version: number, signal: AbortSignal) {
	const update = await job.wait(version, signal);
	if (job.signal.aborted) throw new JobError("The agent job expired. Check the project before retrying.", 410);
	return { ...update, ...(update.done && job.resultFile ? { result: await readJson(job.resultFile) } : {}) };
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
