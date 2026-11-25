import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultRunner, fetchFrame, fetchSection, fetchWebFile, toolsFromEnv } from "./server";
import { getMusic } from "@/sounds/music-server";
import { getSfx } from "@/sounds/sfx-server";
import { cookiePluginFile } from "./yt-dlp-cookies";
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

// Windows has no process group that outlives the tool: only the tree of a running tool is ended there.
if (process.platform !== "win32") test.each(["inherit", "ignore"])("abort reaches a surviving child after the wrapper exits (%s pipes)", async (stdio) => {
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
		require("node:child_process").spawn(process.execPath, ["-e", child, String(process.pid), file], { stdio }).unref();
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

test("a forced stop of the owner ends the tool and the processes it started", async () => {
	const heartbeat = path.join(root, "heartbeat");
	const child = `
		setInterval(() => require("node:fs").appendFileSync(process.argv[1], "."), 20);
		setTimeout(() => process.exit(), 7500);
	`;
	const tool = `
		require("node:child_process").spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { stdio: "ignore" });
		setTimeout(() => process.exit(), 7500);
	`;
	const owner = spawn(process.execPath, ["-e", `
		const { runProcess } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "process.ts")).href)});
		await runProcess(process.execPath, ${JSON.stringify(["-e", tool, child, heartbeat])}, undefined, ${JSON.stringify(root)});
	`], { cwd: path.join(import.meta.dir, "..", ".."), stdio: "ignore", windowsHide: true });
	const contents = () => readFile(heartbeat, "utf8").catch(() => "");
	const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	try {
		for (let i = 0; i < 300 && !(await contents()); i++) await pause(20);
		expect(await contents()).not.toBe("");
		owner.kill("SIGKILL");
		let last: string;
		let tries = 0;
		do {
			last = await contents();
			await pause(300);
		} while (await contents() !== last && ++tries < 10);
		expect(tries).toBeLessThan(10);
	} finally {
		owner.kill("SIGKILL");
	}
}, 15_000);

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

async function verifyCookieCopy(verify: (copy: string) => void, useAlias = false) {
	const original = path.join(root, "configured cookies caf\u00e9.txt");
	const contents = Buffer.from("# Netscape HTTP Cookie File\r\nexample.test\tFALSE\t/\tTRUE\t0\tfixture\tvalue\r\n");
	await writeFile(original, contents);
	const marker = path.join(root, "cookie-copy-path");
	const tool = path.join(root, "fake-yt-dlp.js");
	await writeFile(tool, String.raw`
		const { existsSync, readFileSync, writeFileSync } = require("node:fs");
		const path = require("node:path");
		const [marker, pluginFile, ...args] = process.argv.slice(2);
		const original = args[args.indexOf(args.includes("--session") ? "--session" : "--cookies") + 1];
		const hasPlugin = args.includes("--use-postprocessor") && args.includes("BopencutJobCookies");
		const scratch = args[args.indexOf("--plugin-dirs") + 1];
		// Simulate yt-dlp passing its resolved cookie path to the required postprocessor.
		const copy = hasPlugin && existsSync(path.join(scratch, pluginFile)) ? path.join(scratch, "cookies.txt") : original;
		if (hasPlugin) writeFileSync(path.join(scratch, "cookie-state"), "copy");
		if (copy !== original) writeFileSync(copy, readFileSync(original));
		writeFileSync(copy, "");
		writeFileSync(marker, copy);
		setTimeout(() => process.exit(), 7000);
	`);
	const controller = new AbortController();
	const filesRoot = path.join(root, "files");
	const cookieArgs = useAlias ? ["--alias", "session", "--cookies {0}", "--session", original] : ["--cookies", original];
	const tools = { ...toolsFromEnv({}), ytdlp: [process.execPath, tool, marker, cookiePluginFile, ...cookieArgs] };
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
		expect(await readFile(original)).toEqual(contents);
		verify(copy);
		controller.abort();
		await expect(job).rejects.toThrow(/cancelled/);
		expect(await readFile(original)).toEqual(contents);
		expect(path.relative(filesRoot, copy)).toMatch(/^\.\./);
		await expect(readFile(copy)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(path.join(filesRoot, "retrieved", ".retrieval-jobs"))).toEqual([]);
	} finally {
		controller.abort();
		await job.catch(() => {});
	}
}

test("cancelling yt-dlp after it rewrites its job copy leaves the configured cookie file intact", async () => {
	await verifyCookieCopy(() => {});
}, 10_000);

test("yt-dlp supplies the cookie file resolved from a configured alias to the private copy step", async () => {
	await verifyCookieCopy(() => {}, true);
}, 10_000);

test("private cookie copies stay outside the files root when the temp folder is inside it", async () => {
	const names = ["TMPDIR", "TMP", "TEMP", "HOME", "USERPROFILE"];
	const saved = names.map((name) => process.env[name]);
	const inside = path.join(root, "files", "tmp");
	const home = path.join(root, "home");
	await mkdir(inside, { recursive: true });
	await mkdir(home, { recursive: true });
	process.env.TMPDIR = process.env.TMP = process.env.TEMP = inside;
	process.env.HOME = process.env.USERPROFILE = home;
	try {
		await verifyCookieCopy((copy) => {
			expect(path.relative(inside, copy)).toMatch(/^\.\./);
		});
	} finally {
		names.forEach((name, i) => {
			if (saved[i] === undefined) delete process.env[name];
			else process.env[name] = saved[i];
		});
	}
}, 15_000);

test.skipIf(process.platform !== "win32")("the Windows cookie copy has only the current user in its ACL", async () => {
	await verifyCookieCopy((copy) => {
		const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
		for (const [file, rights] of [[copy, "(I)(F)"], [path.dirname(copy), "(OI)(CI)(F)"]]) {
			const listing = execFileSync(icacls, [file], { encoding: "utf8", windowsHide: true });
			const rules = listing.split("\n").map((line) => line.replace(file, "").trim()).filter((line) => line.includes(":("));
			expect(rules).toEqual([expect.stringMatching(new RegExp("\\\\" + userInfo().username + ":"))]);
			expect(rules[0].endsWith(rights)).toBe(true);
		}
	});
}, 10_000);

test("warm media caches are usable when the files root cannot create scratch", async () => {
	const deps = {
		filesRoot: root,
		env: { BOPENCUT_ALLOW_PRIVATE_URLS: "1", BOPENCUT_MUSIC_LOUDNESS: "off", BOPENCUT_SFX_NORMALIZE: "off" },
		fetchImpl: Object.assign(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), { preconnect: fetch.preconnect }),
		runner: async (_command: string, args: string[]) => {
			const output = args.includes("-o") ? args[args.indexOf("-o") + 1].replace("%(ext)s", args.includes("-x") ? "m4a" : "mp4") : args.at(-1)!;
			await writeFile(output, "media");
			return { stdout: JSON.stringify({ title: "Fixture" }), stderr: "" };
		},
	};
	const url = "https://example.com/media";
	const lookups = [
		() => fetchSection({ url, start: 1, end: 2 }, deps),
		() => fetchFrame({ url, time: 1 }, deps),
		() => fetchWebFile(url, deps),
		() => getMusic("online", url, deps),
		() => getSfx("myinstants", "/media/sounds/test.mp3", deps),
	];
	const saved = await Promise.all(lookups.map((get) => get()));
	const mkdir = spyOn(fs, "mkdir").mockImplementation(async () => {
		throw Object.assign(new Error("read-only files root"), { code: "EROFS" });
	});
	try {
		const cached = await Promise.all(lookups.map((get) => get()));
		expect(cached.map(({ cached, path }) => ({ cached, path }))).toEqual(saved.map(({ path }) => ({ cached: true, path })));
		expect(mkdir).not.toHaveBeenCalled();
	} finally {
		mkdir.mockRestore();
	}
});

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
