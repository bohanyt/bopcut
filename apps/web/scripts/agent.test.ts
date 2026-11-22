import { describe, expect, test } from "bun:test";
import { parseArgs, runJob, type JobConnection } from "./agent";
import { AgentJobs } from "../src/agent/cli-jobs";

describe("agent CLI arguments", () => {
	test("parses export options and project selection", () => {
		expect(parseArgs(["export", "--quality", "medium", "--fps", "24", "--no-audio", "--project-id", "project", "--timeout", "12"]))
			.toMatchObject({ command: "export", projectId: "project", timeoutMs: 12000, request: { quality: "medium", fps: 24, includeAudio: false } });
	});
	test("rejects unknown options, missing inputs and invalid limits", () => {
		expect(() => parseArgs(["draft"])).toThrow("draft requires");
		expect(() => parseArgs(["notes", "--fps", "30"])).toThrow("Unknown option");
		expect(() => parseArgs(["export", "--timeout", "0"])).toThrow("timeout");
		expect(() => parseArgs(["export", "--format", "mov"])).toThrow("format");
	});
});

function connection(overrides: Partial<JobConnection> = {}): JobConnection {
	return {
		submit: async () => ({ id: "job", projectId: "project", hidden: false, version: 0, stage: "waiting for a tab" }),
		wait: async () => ({ version: 1, stage: "saving", done: true, result: { saved: true } }),
		cancel: async () => {},
		...overrides,
	};
}

describe("job lifetime", () => {
	test("uses a visible editor without launching a browser", async () => {
		const result = await runJob(connection(), { timeoutMs: 500, launch: () => { throw new Error("unnecessary launch"); }, progress: () => {} });
		expect(result).toEqual({ saved: true });
	});
	test("cleans up the browser if waiting fails", async () => {
		let stopped = 0;
		let cancelled = 0;
		const server = connection({
			submit: async () => ({ id: "job", projectId: "project", hidden: true, version: 0, stage: "loading the project" }),
			wait: async () => { throw new Error("Restart the server"); },
			cancel: async () => { cancelled++; },
		});
		await expect(runJob(server, { timeoutMs: 500, launch: () => ({ exited: new Promise(() => {}), stop: async () => { stopped++; } }), progress: () => {} }))
			.rejects.toThrow("Restart the server");
		expect([stopped, cancelled]).toEqual([1, 1]);
	});
	test("times out at the last reported stage and stops its browser", async () => {
		const stages: string[] = [];
		let stopped = false;
		const server = connection({
			submit: async () => ({ id: "job", projectId: "project", hidden: true, version: 0, stage: "loading the project" }),
			wait: async (_id, version) => version ? new Promise(() => {}) : { version: 1, stage: "encoding", percent: 25 },
		});
		await expect(runJob(server, { timeoutMs: 25, launch: () => ({ exited: new Promise(() => {}), stop: async () => { stopped = true; } }), progress: (update) => stages.push(update.stage) }))
			.rejects.toThrow("Timed out while encoding");
		expect(stages).toEqual(["loading the project", "encoding"]);
		expect(stopped).toBe(true);
	});
});

test("cancelling a submission before its reply still cancels the predetermined job", async () => {
	let cancelled: string | undefined;
	const server = connection({
		submit: () => new Promise(() => {}),
		cancel: async (id) => { cancelled = id; },
	});
	await expect(runJob(server, { id: "known", timeoutMs: 20, launch: () => { throw new Error("unexpected launch"); }, progress: () => {} }))
		.rejects.toThrow("Timed out while waiting for a tab");
	expect(cancelled).toBe("known");
});

test("a cancellation received before submission prevents the late job from reserving the slot", async () => {
	const jobs = new AgentJobs();
	await jobs.cancel("cancelled");
	expect(() => jobs.create("project", "draft", {}, 1000, "cancelled")).toThrow("cancelled");
	expect(jobs.active).toBeNull();
});

test("a real editor waits for a hidden draft's durable write before opening", async () => {
	const jobs = new AgentJobs();
	const job = jobs.create("project", "draft", {}, 1000);
	expect(job.hidden).toBe(true);
	let opened = false;
	const release = jobs.register("project", "tab");
	const opening = jobs.beforeOpen("project").then(() => { opened = true; });
	await Promise.resolve();
	expect(opened).toBe(false);
	const { promise: saved, resolve: save } = Promise.withResolvers<void>();
	const writing = job.use(() => saved);
	const ending = jobs.close(job);
	await Promise.resolve();
	expect(opened).toBe(false);
	save();
	await Promise.all([writing, ending, opening]);
	expect(opened).toBe(true);
	const visible = jobs.create("project", "export", {}, 1000);
	expect(visible.hidden).toBe(false);
	await jobs.close(visible);
	release();
});

test("a failed rollback refuses the waiting editor and later project writes", async () => {
	const jobs = new AgentJobs(async () => { throw new Error("busy file"); });
	const job = jobs.create("project", "draft", {}, 1000);
	const opening = jobs.beforeOpen("project").catch((error: Error) => error.message);
	const closing = jobs.close(job).catch((error: Error) => error.message);
	expect(await closing).toBe("busy file");
	expect(await opening).toContain("Draft recovery could not finish");
	expect(() => jobs.checkRecovery("project")).toThrow("Restart the editor server");
	expect(() => jobs.checkRecovery("other")).not.toThrow();
});

test("a hidden frame or export does not block a visible editor from opening", async () => {
	const jobs = new AgentJobs();
	const job = jobs.create("project", "frames", {}, 1000);
	expect(job.hidden).toBe(true);
	await jobs.beforeOpen("project");
	await jobs.close(job);
});
