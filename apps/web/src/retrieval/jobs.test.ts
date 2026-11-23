import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultRunner, fetchSection, toolsFromEnv } from "./server";
import { cacheTargets, publishMedia, sharedJob, withScratch } from "./jobs";
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
	const { meta } = await cacheTargets(path.join(root, "cached.json"));
	const media = path.join(path.dirname(meta), path.basename(file));
	const write = fs.writeFile;
	const spy = spyOn(fs, "writeFile").mockImplementation(async (...args) => {
		await write(...args);
		if (path.basename(String(args[0])) === "cached.json") controller.abort();
	});
	try {
		await expect(withScratch(root, controller.signal, async (scratch, signal) => {
			const staged = path.join(scratch, "media");
			await writeFile(staged, "new");
			await publishMedia(staged, media, signal, { file: meta, value: {} });
		})).rejects.toThrow(/cancelled/i);
	} finally {
		spy.mockRestore();
	}
	expect(await readFile(file, "utf8")).toBe("old");
	await expect(readFile(meta, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readdir(path.join(root, ".retrieval-jobs"))).toEqual([]);
});

test.each([false, true])("publishes atomically across volumes (sidecar: %s)", async (sidecar) => {
	const cache = path.join(root, "cache");
	const meta = sidecar ? path.join(cache, "clip.asset", "clip.json") : undefined;
	const target = path.join(meta ? path.dirname(meta) : cache, "clip.mp4");
	const onCacheVolume = (file: string) => file.startsWith(cache + path.sep);
	const rename = fs.rename;
	const commits: string[] = [];
	const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
		const source = String(from), destination = String(to);
		if (onCacheVolume(source) !== onCacheVolume(destination)) {
			throw Object.assign(new Error("cross-device rename"), { code: "EXDEV" });
		}
		if (destination === (meta ? path.dirname(meta) : target)) commits.push(destination);
		await rename(from, to);
	});
	try {
		await withScratch(root, undefined, async (scratch, signal) => {
			const file = path.join(scratch, "media");
			await writeFile(file, "clip");
			expect(await publishMedia(file, target, signal, meta ? { file: meta, value: "metadata" } : undefined)).toBe(true);
		});
		expect(commits).toEqual([meta ? path.dirname(meta) : target]);
		expect(await readFile(target, "utf8")).toBe("clip");
		if (meta) expect(await readFile(meta, "utf8")).toBe('"metadata"');
	} finally {
		spy.mockRestore();
	}
});

test.each(["inherit", "ignore"])("abort reaches a surviving child after the wrapper exits (%s pipes)", async (stdio) => {
	const controller = new AbortController();
	const heartbeat = path.join(root, "heartbeat");
	const grandchild = `
		const [pid, file] = process.argv.slice(1);
		const { appendFileSync } = require("node:fs");
		const timer = setInterval(() => {
			try { process.kill(Number(pid), 0); }
			catch (error) {
				if (error.code !== "ESRCH") throw error;
				clearInterval(timer);
				appendFileSync(file, ".");
				setInterval(() => appendFileSync(file, "."), 20);
			}
		}, 20);
		setTimeout(() => process.exit(), 7500);
	`;
	const parent = `
		const [child, file, stdio] = process.argv.slice(1);
		// On Windows, Bun terminates its non-detached subprocesses when it exits.
		require("node:child_process").spawn(process.execPath, ["-e", child, String(process.pid), file], {
			stdio, detached: process.platform === "win32",
		}).unref();
	`;
	const contents = () => readFile(heartbeat, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
		return "";
	});
	const job = defaultRunner(process.execPath, ["-e", parent, grandchild, heartbeat, stdio], controller.signal);
	const stoppedEarly = job.then(() => { throw new Error("job settled before its child exited"); });
	const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	try {
		while (!(await contents())) await Promise.race([pause(20), stoppedEarly]);
		controller.abort();
		await expect(job).rejects.toThrow(/cancelled/i);
		const stopped = await contents();
		await pause(300);
		expect(await contents()).toBe(stopped);
	} finally {
		controller.abort();
		await job.catch(() => {});
	}
}, 10_000);

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

test("configured tools get a private temp folder that is removed when they exit", async () => {
	const temp = await withScratch(root, undefined, (scratch, signal) =>
		defaultRunner(process.execPath, ["-e", "console.log(require('node:os').tmpdir())"], signal, scratch));
	const folder = temp.stdout.trim();
	expect(path.relative(root, folder)).toMatch(/^\.\./);
	await expect(readdir(folder)).rejects.toMatchObject({ code: "ENOENT" });
});

test("cancelling yt-dlp after it rewrites its job copy leaves the configured cookie file intact", async () => {
	const original = path.join(root, "configured cookies café.txt");
	const contents = Buffer.from("# Netscape HTTP Cookie File\r\nexample.test\tFALSE\t/\tTRUE\t0\tfixture\tvalue\r\n");
	await writeFile(original, contents);
	const marker = path.join(root, "cookie-copy-path");
	const tool = path.join(root, "fake-yt-dlp.js");
	await writeFile(tool, String.raw`
		const { readFileSync, writeFileSync } = require("node:fs");
		const [original, marker, ...args] = process.argv.slice(2);
		if (args.includes("--help")) {
			const repr = (values) => "[" + values.map((value) => JSON.stringify(value)).join(", ") + "]";
			console.error("[debug] Command-line config: " + repr(args));
			console.error('[debug] | Config "test.conf": ' + repr(["--config-locations", "nested.conf"]));
			console.error('[debug] | | Config "nested.conf": ' + repr(["--cookies", original]));
			process.exit(0);
		}
		// Simulate yt-dlp reading and then truncating its configured destination.
		const copy = args.includes("--cookies") ? args[args.lastIndexOf("--cookies") + 1] : original;
		if (!readFileSync(copy).equals(readFileSync(original))) throw new Error("the copy differs");
		writeFileSync(copy, "");
		writeFileSync(marker, copy);
		setTimeout(() => process.exit(), 7000);
	`);
	const controller = new AbortController();
	const filesRoot = path.join(root, "files");
	const tools = { ...toolsFromEnv({}), ytdlp: [process.execPath, tool, original, marker] };
	const job = fetchSection({ url: "https://example.com/video", start: 10, end: 12 }, { filesRoot, tools, signal: controller.signal });
	try {
		let copy: string | undefined;
		while (!copy) {
			copy = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return undefined;
			});
			if (!copy) await Promise.race([job, new Promise((resolve) => setTimeout(resolve, 20))]);
		}
		controller.abort();
		await expect(job).rejects.toThrow(/cancelled/);
		expect(await readFile(original)).toEqual(contents);
		expect(path.relative(filesRoot, copy)).toMatch(/^\.\./);
		await expect(readFile(copy)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(path.join(filesRoot, ".retrieval-jobs"))).toEqual([]);
	} finally {
		controller.abort();
		await job.catch(() => {});
	}
}, 10_000);

test("competing publishers commit one matching pair without replacing it", async () => {
	const { meta } = await cacheTargets(path.join(root, "video.json"));
	const media = path.join(path.dirname(meta), "video.mp4");
	const results = await Promise.all(["first", "second"].map((value) => withScratch(root, undefined, async (scratch, signal) => {
		const source = path.join(scratch, "video.mp4");
		await writeFile(source, value);
		return publishMedia(source, media, signal, { file: meta, value });
	})));
	expect(results.filter(Boolean)).toHaveLength(1);
	const bytes = await readFile(media, "utf8");
	expect(JSON.parse(await readFile(meta, "utf8"))).toBe(bytes);
});
