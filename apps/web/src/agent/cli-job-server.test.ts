import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentJobs } from "./cli-jobs";
import { finishJob, recoverAgentJobs, rememberDraft, snapshotFor, writeWorkspaceSnapshot } from "./cli-job-server";
import { jobRunner } from "@/retrieval/job-runner";

async function inTemporaryData(run: (dir: string) => Promise<void>) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-jobs-test-"));
	const previous = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = dir;
	try { await run(dir); }
	finally {
		if (previous === undefined) delete process.env.BOPENCUT_DATA;
		else process.env.BOPENCUT_DATA = previous;
		await fs.rm(dir, { recursive: true, force: true });
	}
}

test("restart recovery removes an interrupted import and restores its previous words", () => inTemporaryData(async (dir) => {
	const jobs = new AgentJobs();
	const job = jobs.create("project", "draft", {}, 1000);
	const project = path.join(dir, "projects", "project");
	const media = path.join(project, "media");
	const metadata = path.join(media, "_metadata");
	await fs.mkdir(metadata, { recursive: true });
	await fs.writeFile(path.join(project, "project.json"), "{}");
	await fs.writeFile(path.join(metadata, "imported.json"), JSON.stringify({ diskFile: "imported.mp4" }));
	await fs.writeFile(path.join(media, "imported.mp4"), "media");
	await fs.writeFile(path.join(media, "imported.00000000-0000-0000-0000-000000000000.tmp"), "partial upload");
	const existing = path.join(metadata, "existing.json");
	await fs.writeFile(existing, JSON.stringify({ words: ["new"] }));
	job.staged.add("imported");
	job.words.set("existing", ["old"]);
	await rememberDraft(job);
	try {
		await recoverAgentJobs();
		expect(await fs.readdir(media)).toEqual(["_metadata"]);
		expect(JSON.parse(await fs.readFile(existing, "utf8"))).toEqual({ words: ["old"] });
		expect(await fs.readdir(path.join(dir, ".agent-jobs"))).toEqual([]);
	} finally { await jobs.close(job); }
}));

test("completion rejects when cancelled during result publication", () => inTemporaryData(async () => {
	const jobs = new AgentJobs();
	const job = jobs.create("project", "export", {}, 1000);
	const result = job.use(() => finishJob(job, { status: "done" }));
	await Promise.resolve();
	const close = jobs.close(job);
	await expect(result).rejects.toThrow("The job ended");
	await close;
	expect(job.update.done).toBeUndefined();
}));

test("a hidden draft refreshes the last snapshot only when it is the same project", () => inTemporaryData(async (dir) => {
	await writeWorkspaceSnapshot(dir, { projectId: "current", revision: 1 });
	await writeWorkspaceSnapshot(dir, { projectId: "other", revision: 2 }, true);
	expect(await snapshotFor(dir)).toEqual({ projectId: "current", revision: 1 });
	expect(await snapshotFor(dir, "other")).toEqual({ projectId: "other", revision: 2 });
	await writeWorkspaceSnapshot(dir, { projectId: "current", revision: 3 }, true);
	expect(await snapshotFor(dir)).toEqual({ projectId: "current", revision: 3 });
}));

test("cancelling a retrieval stops and joins its tool process", async () => {
	const controller = new AbortController();
	const command = jobRunner(controller.signal)(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
	controller.abort(new Error("cancelled download"));
	await expect(command).rejects.toThrow("cancelled download");
});
