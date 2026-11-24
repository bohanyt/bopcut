import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearProxies, ensureProxySpace, fingerprint, openSession } from "./server";
import * as processes from "@/retrieval/process";

test("proxy cache identity follows content across copies and hard links", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-fingerprint-"));
	const original = path.join(dir, "one.mp4");
	const link = path.join(dir, "two.mp4");
	const copy = path.join(dir, "three.mp4");
	try {
		await fs.writeFile(original, Buffer.alloc(256 * 1024, 3));
		await fs.link(original, link);
		await fs.copyFile(original, copy);
		expect(await fingerprint(original)).toEqual(await fingerprint(link));
		expect(await fingerprint(original)).toEqual(await fingerprint(copy));
		const file = await fs.open(copy, "r+");
		try { await file.write(Buffer.from([2]), 0, 1, 128 * 1024); }
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
		for (const [index, name] of names.entries()) {
			const file = path.join(dir, name);
			await fs.writeFile(file, Buffer.alloc(40));
			await fs.utimes(file, 10 + index, 10 + index);
		}
		expect(await ensureProxySpace(40)).toBe(40);
		expect(await fs.readdir(dir)).toEqual([names[1]]);
		process.env.BOPENCUT_PROXY_FREE_BYTES = String(Number.MAX_SAFE_INTEGER);
		await expect(ensureProxySpace(0)).rejects.toThrow();
		expect(await fs.readdir(dir)).toEqual([names[1]]);
	} finally {
		for (const [index, key] of ["BOPENCUT_DATA", "BOPENCUT_PROXY_LIMIT_BYTES", "BOPENCUT_PROXY_FREE_BYTES"].entries()) {
			if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index];
		}
		for (const name of names) await fs.rm(path.join(dir, name), { force: true });
		await fs.rmdir(dir);
		await fs.rmdir(root);
	}
});

test("starts the nearest queued asset and aborts its work when the tab closes", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "proxy-queue-"));
	const project = path.join(root, "projects", "fixture");
	const dir = path.join(project, "media");
	const meta = path.join(dir, "_metadata");
	const previousRoot = process.env.BOPENCUT_DATA;
	const previousReserve = process.env.BOPENCUT_PROXY_FREE_BYTES;
	process.env.BOPENCUT_DATA = root;
	process.env.BOPENCUT_PROXY_FREE_BYTES = "0";
	const started = Promise.withResolvers<string>();
	const cancelled = Promise.withResolvers<void>();
	const run = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_command, args, signal) => {
		if (args.includes("-encoders")) return { stdout: "h264_nvenc", stderr: "" };
		if (!args.includes("-show_frames")) return { stdout: "", stderr: "" };
		started.resolve(path.basename(args.at(-1)!));
		await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
		cancelled.resolve();
		throw signal.reason;
	});
	let close: (() => void) | undefined;
	const ids = ["near", "far"];
	try {
		await fs.mkdir(meta, { recursive: true });
		for (const id of ids) {
			await fs.writeFile(path.join(dir, id + ".mp4"), id);
			await fs.writeFile(path.join(meta, id + ".json"), JSON.stringify({ type: "video", diskFile: id + ".mp4" }));
		}
		close = openSession("tab", { project: "fixture", ids, paused: false, software: false, send() {} });
		expect(await started.promise).toBe("near.mp4");
		close();
		await cancelled.promise;
	} finally {
		close?.();
		await clearProxies();
		run.mockRestore();
		if (previousRoot === undefined) delete process.env.BOPENCUT_DATA; else process.env.BOPENCUT_DATA = previousRoot;
		if (previousReserve === undefined) delete process.env.BOPENCUT_PROXY_FREE_BYTES; else process.env.BOPENCUT_PROXY_FREE_BYTES = previousReserve;
		for (const id of ids) {
			await fs.rm(path.join(dir, id + ".mp4"), { force: true });
			await fs.rm(path.join(meta, id + ".json"), { force: true });
		}
		for (const folder of [meta, dir, project, path.dirname(project), path.join(root, "proxies"), root]) {
			await fs.rmdir(folder).catch(() => {});
		}
	}
});
