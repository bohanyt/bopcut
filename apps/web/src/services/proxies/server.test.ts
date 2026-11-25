import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { clearProxies, ensureProxySpace, fingerprint, openSession, updateSession } from "./server";
import { acquireProxyWriter } from "./cache-files";
import * as processes from "@/retrieval/process";
import type { ProxyUpdate } from "./mapping";

const ownerRecord = (pid: number, startedAt = Date.now()) => JSON.stringify({ pid, token: "test-owner", startedAt });

test("proxy cache identity follows content across copies and hard links", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-fingerprint-"));
	const original = path.join(dir, "one.mp4");
	const link = path.join(dir, "two.mp4");
	const copy = path.join(dir, "three.mp4");
	try {
		const huge = 32 * 1024 * 1024;
		const created = await fs.open(original, "w");
		try { await created.truncate(huge); } finally { await created.close(); }
		await fs.link(original, link);
		await fs.copyFile(original, copy);
		expect((await fingerprint(original)).key).toBe((await fingerprint(link)).key);
		expect((await fingerprint(original)).key).toBe((await fingerprint(copy)).key);
		const file = await fs.open(copy, "r+");
		// This is in sampled region 7, far from the original head, middle and tail blocks.
		try { await file.write(Buffer.from([2]), 0, 1, Math.floor((32 * 1024 * 1024 - 65536) * 7 / 31) + 100); }
		finally { await file.close(); }
		expect((await fingerprint(original)).key).not.toBe((await fingerprint(copy)).key);
	} finally {
		for (const file of [link, copy, original]) await fs.rm(file, { force: true });
		await fs.rmdir(dir);
	}
});


test("evicts the least recently used file and preserves the cache below the disk reserve", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "proxy-space-"));
	const dir = path.join(root, "proxies");
	const names = ["a", "b"].map(character => character.repeat(64) + "-p1-v1.mp4");
	const old = [process.env.BOPENCUT_DATA, process.env.BOPENCUT_PROXY_LIMIT_BYTES, process.env.BOPENCUT_PROXY_FREE_BYTES];
	process.env.BOPENCUT_DATA = root;
	process.env.BOPENCUT_PROXY_LIMIT_BYTES = "100";
	process.env.BOPENCUT_PROXY_FREE_BYTES = "0";
	try {
		await fs.mkdir(dir);
		expect(await acquireProxyWriter(dir)).toBe(true);
		for (const [index, name] of names.entries()) {
			const file = path.join(dir, name);
			await fs.writeFile(file, Buffer.alloc(40));
			await fs.utimes(file, 10 + index, 10 + index);
		}
		expect(await ensureProxySpace(40)).toBe(40);
		expect((await fs.readdir(dir)).filter(name => name.endsWith(".mp4"))).toEqual([names[1]]);
		process.env.BOPENCUT_PROXY_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
		await expect(ensureProxySpace(0)).rejects.toThrow();
		expect((await fs.readdir(dir)).filter(name => name.endsWith(".mp4"))).toEqual([names[1]]);
	} finally {
		for (const [index, key] of ["BOPENCUT_DATA", "BOPENCUT_PROXY_LIMIT_BYTES", "BOPENCUT_PROXY_FREE_BYTES"].entries()) {
			if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index];
		}
		for (const name of names) await fs.rm(path.join(dir, name), { force: true });
		await fs.rm(path.join(dir, "writer-1.lock"), { force: true });
		await fs.rmdir(dir);
		await fs.rmdir(root);
	}
});

// First of the tests with tools: working encoders are remembered for five minutes.
test("a busy hardware encoder is not remembered as missing", async () => {
	const f = await fixture(["source"]);
	const tested = Promise.withResolvers<void>();
	let clock: { mockRestore(): void } | undefined;
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args) => {
		if (args.includes("-encoders")) return toolResult("h264_nvenc");
		if (args.includes("lavfi")) {
			tested.resolve();
			throw Object.assign(new Error("tool exited with code 1"), { stderr: "No free encoding sessions: too many concurrent sessions" });
		}
		return toolResult();
	});
	try {
		const tab = f.tab("busy", ["source"]);
		await tested.promise;
		await sleep(50);
		expect(tab.events.some(event => event.state === "software")).toBe(false);
		const calls = run.mock.calls.length;
		updateSession("busy", { ids: ["source"] }, 1, ["source"]);
		await sleep(50);
		expect(run.mock.calls).toHaveLength(calls);
		const started = Date.now();
		let now = started + 20_000;
		clock = spyOn(Date, "now").mockImplementation(() => now);
		updateSession("busy", { ids: ["source"] }, 2, ["source"]);
		await sleep(50);
		expect(run.mock.calls).toHaveLength(calls);
		// The update in between does not move the retry.
		now = started + 31_000;
		updateSession("busy", { ids: ["source"] }, 3, ["source"]);
		for (let i = 0; i < 50 && run.mock.calls.length === calls; i++) await sleep(10);
		expect(run.mock.calls.length).toBeGreaterThan(calls);
	} finally {
		clock?.mockRestore();
		await f.dispose();
		run.mockRestore();
	}
});

test("a tool that failed is not tried again until a project opens", async () => {
	const f = await fixture(["source", "other"]);
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async () => { throw new Error("blocked"); });
	try {
		const first = f.tab("first", ["source"]);
		await first.wait(event => event.state === "missing");
		expect(first.events.at(-1)?.error).toBe("blocked");
		expect(run).toHaveBeenCalledTimes(1);
		for (const [index, ids] of [["source", "other"], ["other"], ["source"]].entries()) updateSession("first", { ids }, index + 1, ["source"]);
		await sleep(100);
		expect(run).toHaveBeenCalledTimes(1);
		const second = f.tab("second", ["source"]);
		await second.wait(event => event.state === "missing");
		expect(run).toHaveBeenCalledTimes(2);
	} finally { await f.dispose(); run.mockRestore(); }
});

test("reorders pending assets, cleans interrupted jobs and aborts when the tab closes", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "proxy-queue-"));
	const project = path.join(root, "projects", "fixture");
	const dir = path.join(project, "media");
	const meta = path.join(dir, "_metadata");
	const cache = path.join(root, "proxies");
	const interrupted = [".job-12345678-1234-1234-1234-123456789123.mp4", "a".repeat(64) + "-p1-v1.mp4"];
	const previousRoot = process.env.BOPENCUT_DATA;
	const previousReserve = process.env.BOPENCUT_PROXY_FREE_BYTES;
	process.env.BOPENCUT_DATA = root;
	process.env.BOPENCUT_PROXY_FREE_BYTES = "0";
	const started = Promise.withResolvers<string>();
	const firstFinished = Promise.withResolvers<void>();
	const second = Promise.withResolvers<string>();
	const cancelled = Promise.withResolvers<void>();
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args, signal) => {
		if (args.includes("-encoders")) return { stdout: "h264_nvenc", stderr: "" };
		if (!args.includes("-show_frames")) return { stdout: "", stderr: "" };
		const file = path.basename(args.at(-1)!);
		if (file === "near.mp4") {
			started.resolve(file);
			await firstFinished.promise;
			return { stdout: '{"streams":[],"frames":[]}', stderr: "" };
		}
		second.resolve(file);
		await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
		cancelled.resolve();
		throw signal.reason;
	});
	let close: (() => void) | undefined;
	const ids = ["near", "middle", "far"];
	try {
		await fs.mkdir(meta, { recursive: true });
		await fs.mkdir(cache);
		for (const file of interrupted) await fs.writeFile(path.join(cache, file), "");
		for (const id of ids) {
			await fs.writeFile(path.join(dir, id + ".mp4"), id);
			await fs.writeFile(path.join(meta, id + ".json"), JSON.stringify({ type: "video", diskFile: id + ".mp4" }));
		}
		close = openSession("tab", { project: "fixture", ids, paused: false, software: false, build: true, send() {} });
		expect(await started.promise).toBe("near.mp4");
		expect(await fs.readdir(cache)).toEqual(["writer-1.lock"]);
		updateSession("tab", { ids: ["near", "far", "middle"] }, 1);
		firstFinished.resolve();
		expect(await second.promise).toBe("far.mp4");
		close();
		await cancelled.promise;
	} finally {
		firstFinished.resolve();
		close?.();
		await clearProxies();
		run.mockRestore();
		if (previousRoot === undefined) delete process.env.BOPENCUT_DATA; else process.env.BOPENCUT_DATA = previousRoot;
		if (previousReserve === undefined) delete process.env.BOPENCUT_PROXY_FREE_BYTES; else process.env.BOPENCUT_PROXY_FREE_BYTES = previousReserve;
		for (const id of ids) {
			await fs.rm(path.join(dir, id + ".mp4"), { force: true });
			await fs.rm(path.join(meta, id + ".json"), { force: true });
		}
		for (const file of interrupted) await fs.rm(path.join(cache, file), { force: true });
		await fs.rm(path.join(cache, "writer-1.lock"), { force: true });
		for (const folder of [meta, dir, project, path.dirname(project), cache, root]) {
			await fs.rmdir(folder).catch(() => {});
		}
	}
});

async function fixture(ids: string[], budget = "8000000000") {
	const root = await fs.mkdtemp(path.join(tmpdir(), "proxy-session-"));
	const cache = path.join(root, "proxies");
	const project = path.join(root, "projects", "fixture");
	const media = path.join(project, "media");
	const metadata = path.join(media, "_metadata");
	const env = { BOPENCUT_DATA: root, BOPENCUT_PROXY_FREE_BYTES: "0", BOPENCUT_PROXY_LIMIT_BYTES: budget };
	const previous = Object.keys(env).map(key => [key, process.env[key]] as const);
	Object.assign(process.env, env);
	await fs.mkdir(metadata, { recursive: true });
	await fs.mkdir(cache);
	for (const id of ids) {
		await fs.writeFile(path.join(media, id + ".mp4"), id);
		await fs.writeFile(path.join(metadata, id + ".json"), JSON.stringify({ type: "video", diskFile: id + ".mp4" }));
	}
	const close: (() => void)[] = [];
	return {
		cache, media,
		tab(id: string, ids: string[], paused = false, build = true, retry?: number) {
			const events: ProxyUpdate[] = [];
			let changed = Promise.withResolvers<void>();
			const end = openSession(id, { project: "fixture", ids, paused, software: false, build, retry, send(event) {
				events.push(event);
				changed.resolve();
				changed = Promise.withResolvers<void>();
			} });
			close.push(end);
			return { events, end, async wait(predicate: (event: ProxyUpdate) => boolean, since = 0) {
				while (!events.slice(since).some(predicate)) await changed.promise;
			} };
		},
		async dispose() {
			for (const fn of close) fn();
			await clearProxies();
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			for (const dir of [cache, metadata, media]) {
				for (const file of await fs.readdir(dir)) await fs.rm(path.join(dir, file), { force: true });
				await fs.rmdir(dir);
			}
			for (const dir of [project, path.dirname(project), root]) await fs.rmdir(dir);
		},
	};
}

const toolResult = (stdout = "") => ({ stdout, stderr: "" });
const noVideo = () => toolResult('{"streams":[],"frames":[]}');
function videoProbe(duration: number, encoded = false) {
	return toolResult(JSON.stringify({
		streams: [{ width: encoded ? 960 : 1920, height: encoded ? 540 : 1080, pix_fmt: "yuv420p", time_base: "1/1", duration }],
		frames: [0, 1, 2].map(best_effort_timestamp => ({ best_effort_timestamp, key_frame: 1, pict_type: "I" })),
	}));
}

test("a session that does not build uses existing proxies and starts no tool", async () => {
	const f = await fixture(["ready", "new"]);
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async () => toolResult("h264_nvenc"));
	try {
		const { key, size } = await fingerprint(path.join(f.media, "ready.mp4"));
		const info = { key, size, width: 960, height: 540, source: [0], proxy: [0] };
		await fs.writeFile(path.join(f.cache, key + ".mp4"), "proxy");
		await fs.writeFile(path.join(f.cache, key + ".json"), JSON.stringify(info));
		const manual = f.tab("manual", ["new", "ready"], false, false);
		await manual.wait(event => event.state === "off" && event.done === 2);
		updateSession("manual", { ids: ["ready", "new"] }, 1, ["new"]);
		await sleep(50);
		expect(manual.events.every(event => event.state === "off")).toBe(true);
		expect(manual.events.flatMap(event => event.media ?? []).map(({ id }) => id)).toEqual(["ready"]);
		// A source that is added later and has a proxy is used at once.
		updateSession("manual", { ids: ["new"] }, 2);
		updateSession("manual", { ids: ["new", "ready"] }, 3);
		await manual.wait(event => event.media?.id === "ready" && event.done === 2, 2);
		expect(run).not.toHaveBeenCalled();
		expect((await fs.readdir(f.cache)).sort()).toEqual([key + ".json", key + ".mp4"]);
	} finally { await f.dispose(); run.mockRestore(); }
});

test("preparation stops after three failed sources and says why", async () => {
	const ids = ["a", "b", "c", "d", "e"];
	const f = await fixture(ids);
	const probed: string[] = [];
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args) => {
		if (args.includes("-encoders")) return toolResult("h264_nvenc");
		if (!args.includes("-show_frames")) return toolResult();
		probed.push(path.basename(args.at(-1)!, ".mp4"));
		throw Object.assign(new Error("tool exited with code 1"), { stderr: "banner\nAccess is denied\n" });
	});
	try {
		const { key, size } = await fingerprint(path.join(f.media, "e.mp4"));
		await fs.writeFile(path.join(f.cache, key + ".mp4"), "proxy");
		await fs.writeFile(path.join(f.cache, key + ".json"), JSON.stringify({ key, size, width: 960, height: 540, source: [0], proxy: [0] }));
		const tab = f.tab("failing", ids);
		await tab.wait(event => event.state === "failed" && event.done === 5);
		expect(tab.events.at(-1)?.error).toBe("tool exited with code 1: Access is denied");
		expect(probed).toEqual(["a", "b", "c"]);
		expect(tab.events.flatMap(event => event.media ?? []).map(({ id }) => id)).toEqual(["e"]);
		updateSession("failing", { ids: [...ids].reverse() }, 1);
		await sleep(50);
		expect(probed).toHaveLength(3);
		// Opening a project goes on with the sources that did not fail yet.
		const again = f.tab("again", ids);
		await again.wait(event => event.done === 5 && event.state !== "failed");
		expect(probed).toEqual(["a", "b", "c", "d"]);
		// Asking to try again also takes the failed ones, which do not stop it a second time.
		const retried = f.tab("retried", ids, false, true, 1);
		await retried.wait(event => event.done === 5 && event.state !== "failed");
		expect(probed.slice(4)).toEqual(["a", "b", "c", "d"]);
		const reopened = f.tab("reopened", ids, false, true, 1);
		await reopened.wait(event => event.done === 5 && event.state !== "failed");
		expect(probed).toHaveLength(8);
	} finally { await f.dispose(); run.mockRestore(); }
});

test("a reader does not keep the work of a closed tab running", async () => {
	const f = await fixture(["source"]);
	const started = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args, signal) => {
		if (args.includes("-encoders")) return toolResult("h264_nvenc");
		if (!args.includes("-show_frames")) return toolResult();
		started.resolve();
		await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
		stopped.resolve();
		throw signal.reason;
	});
	try {
		f.tab("reader", ["source"], false, false);
		const builder = f.tab("builder", ["source"]);
		await started.promise;
		builder.end();
		await stopped.promise;
	} finally { await f.dispose(); run.mockRestore(); }
});

test("reversed pause and resume updates cannot override the newest sequence", async () => {
	const f = await fixture(["source"]);
	const started = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	let probes = 0;
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args, signal) => {
		if (args.includes("-encoders")) return toolResult("h264_nvenc");
		if (!args.includes("-show_frames")) return toolResult();
		probes++;
		started.resolve();
		await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
		stopped.resolve();
		throw signal.reason;
	});
	try {
		f.tab("ordered", ["source"], true);
		updateSession("ordered", { paused: false }, 2);
		updateSession("ordered", { paused: true }, 1);
		await started.promise;
		updateSession("ordered", { paused: true }, 4);
		updateSession("ordered", { paused: false }, 3);
		await stopped.promise;
		await sleep(50);
		expect(probes).toBe(1);
	} finally { await f.dispose(); run.mockRestore(); }
});

test("an oversized estimate preserves the cache and yields to the next source", async () => {
	const f = await fixture(["large", "small"], "2500000");
	const preserved = "a".repeat(64) + "-p1-v1";
	const existingVideo = path.join(f.cache, preserved + ".mp4");
	const encoded: string[] = [];
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args) => {
		if (args.includes("-encoders")) return toolResult("h264_nvenc");
		if (args.includes("-show_frames")) {
			const name = path.basename(args.at(-1)!);
			return videoProbe(name === "large.mp4" ? 90 : 3, name.startsWith(".job-"));
		}
		if (args.includes("-fs")) {
			encoded.push(path.basename(args[args.indexOf("-i") + 1]));
			await fs.writeFile(args.at(-1)!, "proxy");
		}
		return toolResult();
	});
	try {
		await fs.writeFile(existingVideo, Buffer.alloc(100_000));
		await fs.writeFile(path.join(f.cache, preserved + ".json"), "{}");
		const tab = f.tab("sizes", ["large", "small"]);
		await tab.wait(event => event.state === "disk" && event.done === 2);
		expect(await fs.stat(existingVideo)).toBeDefined();
		expect(encoded).toEqual(["small.mp4"]);
		expect(tab.events.some(event => event.media?.id === "small")).toBe(true);
	} finally { await f.dispose(); run.mockRestore(); }
});

test.each(["live writer", "permission denied"])("a reader rediscovers copies and claims a free lock on an update (%s)", async (mode) => {
	const f = await fixture(["source"]);
	const lock = path.join(f.cache, "writer-1.lock");
	const holder = mode === "live writer"
		? Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" })
		: undefined;
	const time = Date.now();
	const clock = spyOn(Date, "now").mockReturnValue(time);
	const list = spyOn(fs, "readdir");
	const writeFile = fs.writeFile.bind(fs);
	let permission = !holder;
	const writes = spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
		if (permission && file === lock) throw Object.assign(new Error("read-only"), { code: "EACCES" });
		return writeFile(file, data, options);
	});
	try {
		if (holder) await fs.writeFile(lock, ownerRecord(holder.pid, time + 120_000));
		const tab = f.tab("reader", ["source"]);
		const readonly = (event: ProxyUpdate) => event.state === "readonly" && !event.media;
		await tab.wait(readonly);
		const { key, size } = await fingerprint(path.join(f.media, "source.mp4"));
		await fs.writeFile(path.join(f.cache, key + ".mp4"), "proxy");
		await fs.writeFile(path.join(f.cache, key + ".json"), JSON.stringify({ key, size }));
		let since = tab.events.length;
		const listings = list.mock.calls.filter(([dir]) => dir === f.cache).length;
		updateSession("reader", {}, 1);
		await tab.wait(readonly, since);
		expect(list.mock.calls.filter(([dir]) => dir === f.cache)).toHaveLength(listings);
		expect(tab.events.some(event => event.media)).toBe(false);
		since = tab.events.length;
		clock.mockReturnValue(time + 60_000);
		expect(tab.events).toHaveLength(since);
		updateSession("reader", {}, 2);
		await tab.wait(event => event.media?.info.key === key, since);
		await tab.wait(readonly, since);
		if (holder) { holder.kill(); await holder.exited; }
		permission = false;
		clock.mockReturnValue(time + 120_000);
		since = tab.events.length;
		updateSession("reader", {}, 3);
		await tab.wait(event => event.state === "ready", since);
		const acquired = path.join(f.cache, holder ? "writer-2.lock" : "writer-1.lock");
		expect(JSON.parse(await fs.readFile(acquired, "utf8")).pid).toBe(process.pid);
	} finally {
		if (holder) { holder.kill(); await holder.exited; }
		writes.mockRestore();
		clock.mockRestore();
		list.mockRestore();
		await f.dispose();
	}
});

test("a pause during the first reader lookup leaves the pass pending for resume", async () => {
	const f = await fixture(["source"]);
	const holder = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
	const start = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const source = path.join(f.media, "source.mp4");
	const { key, size } = await fingerprint(source);
	const open = fs.open.bind(fs);
	const list = spyOn(fs, "readdir");
	const listings = () => list.mock.calls.filter(([dir]) => dir === f.cache).length;
	const blockFirst = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
		if (file === source) {
			start.resolve();
			await release.promise;
		}
		return open(file, flags, mode);
	});
	try {
		await fs.writeFile(path.join(f.cache, "writer-1.lock"), ownerRecord(holder.pid));
		await fs.writeFile(path.join(f.cache, key + ".mp4"), "proxy");
		await fs.writeFile(path.join(f.cache, key + ".json"), JSON.stringify({ key, size }));
		const tab = f.tab("interrupted-reader", ["source"]);
		await start.promise;
		const beforePause = listings();
		updateSession("interrupted-reader", { paused: true }, 1);
		release.resolve();
		// The next listing is after the work loop has observed the pause.
		for (let i = 0; i < 100 && listings() === beforePause; i++) await sleep(1);
		expect(listings()).toBeGreaterThan(beforePause);
		expect(tab.events).toEqual([]);
		updateSession("interrupted-reader", { paused: false }, 2);
		await tab.wait(event => event.state === "readonly" && !event.media && event.done === 1);
		expect(tab.events.some(event => event.media?.info.key === key)).toBe(true);
	} finally {
		release.resolve();
		blockFirst.mockRestore();
		list.mockRestore();
		holder.kill();
		await holder.exited;
		await f.dispose();
	}
});

test("tabs take turns even when the second joins during a job", async () => {
	const f = await fixture(["a1", "a2", "b1", "b2"]);
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const probes: string[] = [];
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args) => {
		if (args.includes("-encoders")) return toolResult("h264_nvenc");
		if (!args.includes("-show_frames")) return toolResult();
		const name = path.basename(args.at(-1)!);
		probes.push(name);
		if (name === "a1.mp4") { started.resolve(); await finish.promise; }
		return noVideo();
	});
	try {
		const a = f.tab("a", ["a1", "a2"]);
		await started.promise;
		const b = f.tab("b", ["b1", "b2"]);
		finish.resolve();
		await Promise.all([a.wait(event => event.state === "ready"), b.wait(event => event.state === "ready")]);
		expect(probes).toEqual(["a1.mp4", "b1.mp4", "a2.mp4", "b2.mp4"]);
	} finally { finish.resolve(); await f.dispose(); run.mockRestore(); }
});

test("a shared encode stays alive after its first tab closes", async () => {
	const f = await fixture(["shared"]);
	const started = Promise.withResolvers<AbortSignal>();
	const finish = Promise.withResolvers<void>();
	let encodes = 0;
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args, signal) => {
		if (args.includes("-encoders")) return toolResult("h264_nvenc");
		if (args.includes("-show_frames")) return videoProbe(3, path.basename(args.at(-1)!).startsWith(".job-"));
		if (args.includes("-fs")) {
			encodes++;
			started.resolve(signal);
			await finish.promise;
			signal.throwIfAborted();
			await fs.writeFile(args.at(-1)!, "proxy");
		}
		return toolResult();
	});
	try {
		const a = f.tab("a", ["shared"]);
		const signal = await started.promise;
		const b = f.tab("b", ["shared"]);
		a.end();
		await sleep(50);
		expect(signal.aborted).toBe(false);
		finish.resolve();
		await b.wait(event => event.media?.id === "shared");
		expect(encodes).toBe(1);
	} finally { finish.resolve(); await f.dispose(); run.mockRestore(); }
});

test("losing the writer token stops encoding and switches the session to reading", async () => {
	const f = await fixture(["source"]);
	const holder = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
	const started = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args, signal) => {
		if (args.includes("-encoders")) return toolResult("h264_nvenc");
		if (args.includes("-show_frames")) return videoProbe(3);
		if (args.includes("-fs")) {
			await fs.writeFile(args.at(-1)!, "partial");
			started.resolve();
			await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			stopped.resolve();
			throw signal.reason;
		}
		return toolResult();
	});
	try {
		const tab = f.tab("displaced", ["source"]);
		await started.promise;
		await fs.writeFile(path.join(f.cache, "writer-2.lock"), ownerRecord(holder.pid));
		await stopped.promise;
		await tab.wait(event => event.state === "readonly");
		expect(tab.events.some(event => event.media)).toBe(false);
		expect((await fs.readdir(f.cache)).every(name => name.endsWith(".lock") || name.startsWith(".job-"))).toBe(true);
	} finally {
		holder.kill();
		await holder.exited;
		await f.dispose();
		run.mockRestore();
	}
});
