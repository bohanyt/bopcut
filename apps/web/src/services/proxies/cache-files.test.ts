import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir, uptime } from "node:os";
import path from "node:path";
import { acquireProxyWriter, ownsProxyWriter, proxyDirectory, proxyFile } from "./cache-files";

const lockRecord = (pid: number, startedAt = Date.now()) => JSON.stringify({ pid, token: "previous-token", startedAt });

async function removeLocks(dir: string) {
	for (const name of await fs.readdir(dir)) await fs.rm(path.join(dir, name));
	await fs.rmdir(dir);
}

test("a live writer is exclusive and a stopped writer's lock can be reclaimed", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-"));
	const lock = path.join(dir, "writer-1.lock");
	const writer = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
	try {
		await fs.writeFile(lock, lockRecord(writer.pid));
		expect(await acquireProxyWriter(dir)).toBe(false);
		writer.kill();
		await writer.exited;
		expect(await acquireProxyWriter(dir)).toBe(true);
		expect(await fs.readdir(dir)).toEqual(["writer-2.lock"]);
		expect(await ownsProxyWriter(dir)).toBe(true);
	} finally {
		writer.kill();
		await writer.exited;
		await removeLocks(dir);
	}
});

function contender(dir: string, stallAfterCreate = false) {
	const childProgram = `
		import { promises as fs } from "node:fs";
		const { acquireProxyWriter } = await import(${JSON.stringify(path.join(import.meta.dir, "cache-files.ts").replaceAll("\\", "/"))});
		const wait = (message) => {
			const next = new Promise(resolve => process.once("message", resolve));
			process.send(message);
			return next;
		};
		const write = fs.writeFile.bind(fs);
		fs.writeFile = async (file, record, options) => {
			if (!${stallAfterCreate}) { await wait("stale"); return write(file, record, options); }
			const handle = await fs.open(file, options.flag);
			try { await wait("stale"); await handle.writeFile(record); }
			finally { await handle.close(); }
		};
		process.send(await acquireProxyWriter(process.argv[1]));
	`;
	const stale = Promise.withResolvers<void>();
	const result = Promise.withResolvers<boolean>();
	const child = Bun.spawn([process.execPath, "--tsconfig-override",
		path.resolve(import.meta.dir, "../../../tsconfig.json"), "-e", childProgram, dir], {
		stdout: "ignore", stderr: "inherit",
		ipc(message) {
			if (message === "stale") stale.resolve();
			if (typeof message === "boolean") result.resolve(message);
		},
	});
	return { child, stale: stale.promise, result: result.promise, release: () => child.send("create") };
}

test.each([0, 1])("stale contenders in release order %i have one successful acquire", async first => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-race-"));
	await fs.writeFile(path.join(dir, "writer-1.lock"), lockRecord(process.pid, 0));
	const attempts = [contender(dir), contender(dir)];
	try {
		await Promise.all(attempts.map(attempt => attempt.stale));
		attempts[first].release();
		expect(await attempts[first].result).toBe(true);
		attempts[1 - first].release();
		expect(await attempts[1 - first].result).toBe(false);
		expect(await fs.readdir(dir)).toEqual(["writer-2.lock"]);
	} finally {
		for (const attempt of attempts) attempt.child.kill();
		await Promise.all(attempts.map(attempt => attempt.child.exited));
		await removeLocks(dir);
	}
});

test("a delayed contender cannot take over a generation already replaced by a third writer", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-delayed-"));
	await fs.writeFile(path.join(dir, "writer-1.lock"), lockRecord(process.pid, 0));
	const first = contender(dir), delayed = contender(dir);
	try {
		await Promise.all([first.stale, delayed.stale]);
		first.release();
		expect(await first.result).toBe(true);
		first.child.kill();
		await first.child.exited;
		expect(await acquireProxyWriter(dir)).toBe(true);
		delayed.release();
		expect(await delayed.result).toBe(false);
		expect(await ownsProxyWriter(dir)).toBe(true);
		expect(await fs.readdir(dir)).toEqual(["writer-3.lock"]);
	} finally {
		first.child.kill();
		delayed.child.kill();
		await Promise.all([first.child.exited, delayed.child.exited]);
		await removeLocks(dir);
	}
});

test("a pre-boot lock is stale even if its pid is alive", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-boot-"));
	try {
		await fs.writeFile(path.join(dir, "writer-1.lock"), lockRecord(process.pid, Date.now() - (uptime() + 86_400) * 1000));
		expect(await acquireProxyWriter(dir)).toBe(true);
		expect(await fs.readdir(dir)).toEqual(["writer-2.lock"]);
	} finally { await removeLocks(dir); }
});

test("a five-minute forward clock correction keeps a live writer", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-clock-"));
	const now = Date.now();
	const record = lockRecord(process.pid, now - uptime() * 1000 + 1000);
	const clock = spyOn(Date, "now").mockReturnValue(now + 300_000);
	try {
		await fs.writeFile(path.join(dir, "writer-1.lock"), record);
		expect(await acquireProxyWriter(dir)).toBe(false);
		expect(await fs.readdir(dir)).toEqual(["writer-1.lock"]);
	} finally { clock.mockRestore(); await removeLocks(dir); }
});

test.each(["", '{"pid":'])("an incomplete record stays exclusive until its mtime reaches ten seconds (%j)", async record => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-incomplete-"));
	const file = path.join(dir, "writer-1.lock");
	const now = Math.floor(Date.now() / 1000) * 1000;
	const clock = spyOn(Date, "now").mockReturnValue(now);
	try {
		await fs.writeFile(file, record);
		await fs.utimes(file, new Date(now - 9000), new Date(now - 9000));
		expect(await acquireProxyWriter(dir)).toBe(false);
		clock.mockReturnValue(now + 1000);
		expect(await acquireProxyWriter(dir)).toBe(true);
		expect(await fs.readdir(dir)).toEqual(["writer-2.lock"]);
	} finally { clock.mockRestore(); await removeLocks(dir); }
});

test("a writer stalled after exclusive create gives way to the successor", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-incomplete-race-"));
	const delayed = contender(dir, true);
	try {
		await delayed.stale;
		const file = path.join(dir, "writer-1.lock");
		expect(await fs.readFile(file, "utf8")).toBe("");
		const aged = new Date(Date.now() - 11_000);
		await fs.utimes(file, aged, aged);
		expect(await acquireProxyWriter(dir)).toBe(true);
		delayed.release();
		expect(await delayed.result).toBe(false);
		expect(await ownsProxyWriter(dir)).toBe(true);
		expect(await fs.readdir(dir)).toEqual(["writer-2.lock"]);
	} finally { delayed.child.kill(); await delayed.child.exited; await removeLocks(dir); }
});

test("lock names are case-insensitive and only safe generations count", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-writer-generation-"));
	const ignored = "writer-9007199254740992.lock";
	const largest = "writer-9007199254740991.lock";
	try {
		await fs.writeFile(path.join(dir, "WRITER-1.LOCK"), lockRecord(process.pid, 0));
		await fs.writeFile(path.join(dir, ignored), "");
		expect(await acquireProxyWriter(dir)).toBe(true);
		expect(await fs.readdir(dir)).toEqual([ignored, "writer-2.lock"].sort());
		await fs.writeFile(path.join(dir, largest), lockRecord(process.pid, 0));
		expect(await acquireProxyWriter(dir)).toBe(false);
		expect(await ownsProxyWriter(dir)).toBe(false);
	} finally { await removeLocks(dir); }
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
