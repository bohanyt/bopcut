import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentJobs } from "./cli-jobs";
import { finishJob, prepareJobOutput, recoverAgentJobs, rememberDraft, snapshotFor, writeWorkspaceSnapshot } from "./cli-job-server";
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

test("restart keeps completed outputs and removes only unfinished job folders", () => inTemporaryData(async (dir) => {
	const jobs = new AgentJobs();
	const unfinished = jobs.create("project", "export", {}, 1000);
	const pendingDir = await prepareJobOutput(unfinished, dir, "exports");
	await fs.mkdir(pendingDir, { recursive: true });
	await fs.writeFile(path.join(pendingDir, "unfinished.mp4"), "unpublished");
	await jobs.close(unfinished);

	const complete = jobs.create("project", "frames", {}, 1000);
	const resultDir = await prepareJobOutput(complete, dir, "frames");
	await fs.mkdir(resultDir, { recursive: true });
	await fs.writeFile(path.join(resultDir, "0.jpg"), "image");
	await finishJob(complete, { files: [`frames/${complete.id}/0.jpg`] });

	const legacy = path.join(dir, "exports", "legacy.mp4");
	await fs.writeFile(legacy, "legacy");
	try {
		await recoverAgentJobs();
		expect(await fs.readdir(path.dirname(pendingDir))).toEqual(["legacy.mp4"]);
		expect(await fs.readFile(path.join(resultDir, "0.jpg"), "utf8")).toBe("image");
	} finally { await jobs.close(complete); }
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

test("the retrieval supervisor forwards tool output", async () => {
	const result = await jobRunner(new AbortController().signal)(process.execPath, ["-e", "console.log('ready')"]);
	expect(result.stdout.trim()).toBe("ready");
});

test("the retrieval tool exits when its server process is killed", () => inTemporaryData(async (dir) => {
	const pidFile = path.join(dir, "tool.pid");
	const runner = path.resolve(import.meta.dir, "../retrieval/job-runner.ts");
	const tool = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const script = `import { jobRunner } from ${JSON.stringify(runner)}; await jobRunner(new AbortController().signal)(process.execPath, ["-e", ${JSON.stringify(tool)}]);`;
	const server = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	let pid: number | undefined;
	try {
		for (let attempt = 0; attempt < 100 && !pid; attempt++) {
			pid = Number(await fs.readFile(pidFile, "utf8").catch(() => ""));
			if (!pid) await Bun.sleep(20);
		}
		expect(pid).toBeGreaterThan(0);
		server.kill("SIGKILL");
		await server.exited;
		let alive = true;
		for (let attempt = 0; attempt < 100 && alive; attempt++) {
			try { process.kill(pid!, 0); }
			catch { alive = false; }
			if (alive) await Bun.sleep(20);
		}
		expect(alive).toBe(false);
		pid = undefined;
	} finally {
		server.kill("SIGKILL");
		await server.exited;
		if (pid) {
			try { process.kill(pid, "SIGKILL"); } catch {}
		}
	}
}));

test("cancelling a retrieval stops and joins its tool process", async () => {
	const controller = new AbortController();
	const command = jobRunner(controller.signal)(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
	controller.abort(new Error("cancelled download"));
	await expect(command).rejects.toThrow("cancelled download");
});
