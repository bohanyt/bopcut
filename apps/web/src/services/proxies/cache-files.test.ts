import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireProxyWriter, proxyDirectory, proxyFile } from "./cache-files";

test("a live writer is exclusive and a stopped writer's lock can be reclaimed", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-"));
	const lock = path.join(dir, ".writer");
	const writer = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
	try {
		await fs.writeFile(lock, String(writer.pid));
		expect(await acquireProxyWriter(dir)).toBe(false);
		writer.kill();
		await writer.exited;
		expect(await acquireProxyWriter(dir)).toBe(true);
		expect(await fs.readFile(lock, "utf8")).toMatch(new RegExp(`^${process.pid}:[a-f0-9-]{36}$`));
	} finally {
		writer.kill();
		await writer.exited;
		await fs.rm(lock, { force: true });
		await fs.rmdir(dir);
	}
});

test("two stale-lock claimants can both write, but only the surviving token owns the cache", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-race-"));
	const lock = path.join(dir, ".writer");
	const previous = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
	await previous.exited;
	const childProgram = `
		import { promises as fs } from "node:fs";
		const { acquireProxyWriter, ownsProxyWriter } = await import(${JSON.stringify(path.join(import.meta.dir, "cache-files.ts").replaceAll("\\", "/"))});
		const wait = (message) => {
			const next = new Promise(resolve => process.once("message", resolve));
			process.send(message);
			return next;
		};
		const unlink = fs.unlink.bind(fs);
		fs.unlink = async (...args) => { await wait("stale"); return unlink(...args); };
		const write = fs.writeFile.bind(fs);
		fs.writeFile = async (...args) => { await write(...args); await wait("claimed"); };
		const owns = await acquireProxyWriter(process.argv[1]);
		process.send(owns && await ownsProxyWriter(process.argv[1]));
	`;
	function start() {
		const stale = Promise.withResolvers<void>();
		const claimed = Promise.withResolvers<void>();
		const result = Promise.withResolvers<boolean>();
		const processHandle = Bun.spawn([process.execPath, "--tsconfig-override",
			path.resolve(import.meta.dir, "../../../tsconfig.json"), "-e", childProgram, dir], {
			stdout: "ignore", stderr: "inherit",
			ipc(message) {
				if (message === "stale") stale.resolve();
				if (message === "claimed") claimed.resolve();
				if (typeof message === "boolean") result.resolve(message);
			},
		});
		return { processHandle, stale: stale.promise, claimed: claimed.promise, result: result.promise };
	}
	await fs.writeFile(lock, `${previous.pid}:old-token`);
	const a = start(), b = start();
	try {
		await Promise.all([a.stale, b.stale]);
		a.processHandle.send("remove");
		await a.claimed;
		b.processHandle.send("remove");
		await b.claimed;
		a.processHandle.send("confirm");
		b.processHandle.send("confirm");
		expect(await Promise.all([a.result, b.result])).toEqual([false, true]);
	} finally {
		for (const child of [a, b]) child.processHandle.kill();
		await Promise.all([a.processHandle.exited, b.processHandle.exited]);
		await fs.rm(lock, { force: true });
		await fs.rmdir(dir);
	}
});

test("refuses a linked cache directory and files with multiple names", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "proxy-root-"));
	const target = path.join(root, "target");
	const alias = path.join(root, "proxies");
	const file = path.join(target, "copy.mp4");
	const linked = path.join(target, "linked.mp4");
	const previous = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = root;
	try {
		await fs.mkdir(target);
		await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
		expect(await proxyDirectory(true)).toBeUndefined();
		await fs.writeFile(file, "copy");
		expect(await proxyFile(file)).toBeDefined();
		await fs.link(file, linked);
		expect(await proxyFile(file)).toBeUndefined();
		expect(await proxyFile(linked)).toBeUndefined();
	} finally {
		if (previous === undefined) delete process.env.BOPENCUT_DATA; else process.env.BOPENCUT_DATA = previous;
		for (const item of [linked, file, alias]) await fs.rm(item, { force: true });
		await fs.rmdir(target);
		await fs.rmdir(root);
	}
});
