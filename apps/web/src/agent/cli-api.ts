import { promises as fs } from "node:fs";
import path from "node:path";
import { dataRoot, safeId } from "@/services/storage/server/files";
import { agentJobs, checkProjectExists, editorPresence, finishJob, getJob, JobError, snapshotFor, waitForJob } from "./cli-job-server";
import { JOB_HEADER, jobCommands, type JobBody, type JobCommand } from "./cli-jobs";
import { isForeignOrigin } from "./origin";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const defaultProject = async (workspace: string) => (await snapshotFor(workspace))?.projectId;

function id(value: unknown) {
	if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new JobError("Pass a valid --project-id or open a project in the editor.");
	return safeId(value);
}

async function preference(root?: string) {
	if (!root) return { missing: true, content: null };
	try { return { missing: false, content: await fs.readFile(path.join(root, "PREFERENCES.md"), "utf8") }; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { missing: true, content: null };
	}
}

export async function handleCli(req: Request, slug: string[], workspace: string): Promise<Response> {
	const url = new URL(req.url);
	if (!["localhost", "127.0.0.1"].includes(url.hostname) || isForeignOrigin(req) || req.headers.get("sec-fetch-site") === "cross-site") {
		return json({ error: "Use the agent CLI on the local editor server." }, 403);
	}
	try {
		const [, action, token] = slug;
		if (req.method === "GET") {
			if (action === "prefs") return json({
				general: await preference(process.env.AGENT_PREFS), workspace: await preference(workspace),
			});
			if (action === "presence") return editorPresence(req, id(url.searchParams.get("projectId")), id(url.searchParams.get("tab")));
			if (action === "selection") {
				const selected = await fs.readFile(path.join(workspace, "selection.json"), "utf8").then(
					(text) => JSON.parse(text) as JobBody,
					(error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; },
				);
				const requested = url.searchParams.get("projectId");
				return json({ selection: !requested || requested === selected?.projectId ? selected : null });
			}
			if (action === "status" || action === "notes") {
				const projectId = id(url.searchParams.get("projectId") ?? await defaultProject(workspace));
				await checkProjectExists(projectId);
				const snap = await snapshotFor(workspace, projectId);
				return json(action === "status"
					? { projectId, serving: agentJobs.serving(projectId), snapshot: snap }
					: { projectId, notes: snap?.notes ?? [], syncedAt: snap?.syncedAt ?? null });
			}
			if (action === "wait") {
				return json(await waitForJob(getJob(token), Number(url.searchParams.get("version")), req.signal));
			}
			if (action === "watch") {
				const job = getJob(token);
				if (job.owner !== req.headers.get(JOB_HEADER)) throw new JobError("The job belongs to another tab.", 403);
				const signal = AbortSignal.any([job.signal, req.signal]);
				if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				return json({ cancelled: true });
			}
		}
		if (req.method === "POST") {
			if (action === "submit") {
				const { projectId: requested, command, request, timeoutMs } = await req.json();
				if (!jobCommands.includes(command) || !request || typeof request !== "object" || Array.isArray(request) ||
					!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 24 * 60 * 60 * 1000) {
					throw new JobError("Invalid job. Check the command and timeout.");
				}
				if (requested !== undefined && request.projectId !== undefined && requested !== request.projectId) {
					throw new JobError("The request project differs from --project-id. Choose one project.");
				}
				const projectId = id(requested ?? request.projectId ?? await defaultProject(workspace));
				await checkProjectExists(projectId);
				if (command === "changes" && !agentJobs.serving(projectId)) throw new JobError("Changes need the editor's timeline history. Open this project in the editor and take a new snapshot.", 409);
				const job = agentJobs.create(projectId, command, { ...request, projectId }, timeoutMs);
				job.body.rev ??= job.id;
				return json({ id: job.id, projectId, hidden: job.hidden, profile: path.join(dataRoot(), ".agent-browser"), ...job.update });
			}
			const job = getJob(token);
			if (action === "cancel") {
				await agentJobs.close(job, "The command was cancelled");
				return json({ ok: true });
			}
			const owner = req.headers.get(JOB_HEADER);
			if ((action === "claim" || action === "fail" || action === "progress") && owner) {
				if (action === "claim" && job.hidden && owner === job.id && job.claim(owner)) {
					return json({ id: job.id, command: job.command, projectId: job.projectId });
				}
				if (owner !== job.owner) throw new JobError("The job belongs to another tab.", 403);
				if (action === "progress") {
					const { stage } = await req.json();
					if (typeof stage === "string") job.progress(stage);
				} else if (action === "fail") {
					const { error } = await req.json();
					await job.use(() => finishJob(job, { error: typeof error === "string" ? error : "The editor could not finish this job. Check the project and retry." }));
				}
				return json({ ok: true });
			}
		}
	} catch (error) {
		return json({ error: error instanceof Error ? error.message : "Agent command failed. Check the editor server and retry." }, error instanceof JobError ? error.status : 400);
	}
	return json({ error: "Unknown agent command." }, 404);
}

export function offerVisibleJob(req: Request) {
	const tab = req.headers.get("x-bopencut-tab");
	const projectId = req.headers.get("x-bopencut-project");
	const job = agentJobs.active;
	if (!tab || !job || job.hidden || job.projectId !== projectId || !agentJobs.serving(projectId, tab) || job.owner) return null;
	const stage = req.headers.get("x-bopencut-stage");
	if (stage !== "ready") {
		if (stage && ["loading the project", "loading media", "saving", "waiting for the editor"].includes(stage)) job.progress(stage);
		return null;
	}
	if (req.headers.get("x-bopencut-graphics") !== "ready" && (job.command === "frames" || job.command === "export")) {
		job.progress("waiting for graphics");
		return null;
	}
	return job.claim(tab) ? { id: job.id, command: job.command, projectId: job.projectId } : null;
}

export function requestKey(command: JobCommand): string {
	return command === "draft" ? "draft" : command + "-request";
}
