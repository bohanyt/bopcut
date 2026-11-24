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
		expect(await fs.readFile(lock, "utf8")).toBe(String(process.pid));
	} finally {
		writer.kill();
		await writer.exited;
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
