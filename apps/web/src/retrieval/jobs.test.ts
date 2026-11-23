import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultRunner } from "./server";
import { publishMedia, sharedJob, withScratch } from "./jobs";
import { ownedJobName } from "@/agent/job-scratch";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "retrieval-job-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("abort closes the child tree before cleaning scratch", async () => {
	const controller = new AbortController();
	const connected = Promise.withResolvers<Socket>();
	const server = createServer((socket) => connected.resolve(socket));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing test listener");
	const grandchild = 'require("node:net").connect(Number(process.argv[1]), "127.0.0.1")';
	const parent = 'require("node:child_process").spawn(process.execPath, ["-e", process.argv[1], process.argv[2]]); setInterval(() => {}, 1000)';
	const job = withScratch(root, controller.signal, async (scratch, signal) => {
		await writeFile(path.join(scratch, "part"), "partial");
		await defaultRunner(process.execPath, ["-e", parent, grandchild, String(address.port)], signal);
	});
	try {
		const socket = await Promise.race([connected.promise, job.then(() => { throw new Error("tool exited early"); })]);
		const closed = new Promise<void>((resolve) => socket.once("close", resolve));
		controller.abort();
		await expect(job).rejects.toThrow(/cancelled/i);
		await closed;
		expect(await readdir(path.join(root, ".retrieval-jobs"))).toEqual([]);
	} finally {
		controller.abort();
		await job.catch(() => {});
		server.close();
	}
}, 10_000);

test("interrupted publication preserves the previous media", async () => {
	const file = path.join(root, "cached.mp4");
	await writeFile(file, "old");
	const controller = new AbortController();
	await expect(withScratch(root, controller.signal, async (scratch, signal) => {
		const staged = path.join(scratch, "media");
		await writeFile(staged, "new");
		controller.abort();
		await publishMedia(staged, file, signal, { file: path.join(root, "cached.json"), value: {} });
	})).rejects.toThrow(/cancelled/i);
	expect(await readFile(file, "utf8")).toBe("old");
	expect(await readdir(path.join(root, ".retrieval-jobs"))).toEqual([]);
});

test("one of two waiters can cancel while the shared job continues", async () => {
	const run = sharedJob<string>();
	const controller = new AbortController();
	const result = Promise.withResolvers<string>();
	let starts = 0;
	const work = (signal: AbortSignal) => {
		starts++;
		expect(signal.aborted).toBe(false);
		return result.promise;
	};
	const first = run("key", controller.signal, work);
	const second = run("key", undefined, work);
	controller.abort();
	await expect(first).rejects.toThrow(/cancelled/i);
	result.resolve("done");
	expect(await second).toBe("done");
	expect(starts).toBe(1);
});

test("a new request reclaims abandoned scratch and preserves a live owner's scratch", async () => {
	const parent = path.join(root, ".retrieval-jobs");
	const abandoned = "01234567-0000-0000-0000-012345678901";
	const live = ownedJobName("01234567-0000-0000-0000-012345678902");
	await mkdir(path.join(parent, abandoned), { recursive: true });
	await mkdir(path.join(parent, live));
	await withScratch(root, undefined, async () => {});
	expect(await readdir(parent)).toEqual([live]);
});
