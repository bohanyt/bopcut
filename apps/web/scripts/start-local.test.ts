import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../../../script/start-local.mjs", import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
	cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
}).trim();

async function freePort(): Promise<number> {
	const socket = net.createServer();
	await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
	const address = socket.address();
	if (!address || typeof address === "string") throw new Error("Expected a test port");
	await new Promise<void>((resolve) => socket.close(() => resolve()));
	return address.port;
}

test("startup updates a temporary clone and falls back after a failed build", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bopencut-start-test-"));
	const origin = path.join(root, "origin");
	const clone = path.join(root, "clone");
	const data = path.join(root, "data");
	const web = path.join(origin, "apps", "web");
	const build = `import { mkdir, readFile, writeFile } from "node:fs/promises";
const label = (await readFile("VERSION", "utf8")).trim();
if (label === "broken") process.exit(1);
const out = ".next/standalone/apps/web";
await mkdir(out, { recursive: true });
if (label === "bad-server") {
 await writeFile(out + "/server.js", "process.exit(1)");
 process.exit(0);
}
await writeFile(out + "/server.js", \`const http = require("node:http");
const server = http.createServer((req, res) => {
 res.end(JSON.stringify({ label: \${JSON.stringify(label)}, data: process.env.BOPENCUT_DATA }));
 if (req.url === "/stop") server.close();
});
server.listen(Number(process.env.PORT), process.env.HOSTNAME);\`);`;
	await fs.mkdir(web, { recursive: true });
	await fs.mkdir(data);
	await fs.mkdir(path.join(origin, "script"));
	await fs.writeFile(path.join(data, "original.txt"), "keep this file");
	await fs.copyFile(launcher, path.join(origin, "script", "start-local.mjs"));
	await fs.writeFile(path.join(origin, ".gitignore"), ".next/\nnode_modules/\n");
	await fs.writeFile(path.join(origin, "package.json"), JSON.stringify({ name: "test-root", workspaces: ["apps/*"] }));
	await fs.writeFile(path.join(web, "package.json"), JSON.stringify({ name: "test-editor", scripts: { build: "bun build.mjs" } }));
	await fs.writeFile(path.join(web, "build.mjs"), build);
	await fs.writeFile(path.join(web, "VERSION"), "first");
	execFileSync(process.execPath, ["--no-env-file", "install"], { cwd: origin, windowsHide: true, stdio: "pipe" });
	git(origin, "init", "-b", "main");
	git(origin, "config", "user.name", "Test");
	git(origin, "config", "user.email", "test@example.test");
	const commit = (message: string) => {
		git(origin, "add", ".");
		git(origin, "commit", "-m", message);
		return git(origin, "rev-parse", "HEAD");
	};
	const first = commit("First editor");
	git(root, "clone", origin, clone);
	const state = path.join(clone, ".git", "bopencut-local");
	const lock = path.join(state, "starting");
	const cached = async () => (await fs.readdir(path.join(state, "builds"))).sort();
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	async function start(label: string, ...flags: string[]) {
		const processEnv = { ...process.env, BOPENCUT_AUTO_UPDATE: "1", BOPENCUT_DATA: data };
		const launch = spawn(process.execPath, ["--no-env-file", "script/start-local.mjs", `--port=${port}`, ...flags], {
			cwd: clone, env: processEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
		});
		let log = "";
		launch.stdout.on("data", (chunk) => { log += chunk; });
		launch.stderr.on("data", (chunk) => { log += chunk; });
		const exit = new Promise<number | null>((resolve) => launch.once("close", resolve));
		try {
			for (let attempt = 0; attempt < 250 && launch.exitCode === null && !log.includes("/projects"); attempt++) await Bun.sleep(20);
			if (!log.includes("/projects")) throw new Error(`Editor startup failed (exit ${launch.exitCode}).\n${log}`);
			const response = await fetch(url);
			expect(await response.json()).toEqual({ label, data });
		} finally {
			await fetch(`${url}/stop`, { signal: AbortSignal.timeout(1000) }).catch(() => launch.kill());
			await exit;
		}
		return log;
	}
	try {
		await fs.mkdir(lock, { recursive: true });
		const holder = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
		try {
			await fs.writeFile(path.join(lock, `owner-${holder.pid}-starting-test`), "");
			const blocked = Bun.spawnSync([process.execPath, "--no-env-file", "script/start-local.mjs", `--port=${port}`, "--no-update"], { cwd: clone });
			expect(blocked.exitCode).toBe(1);
			expect(blocked.stderr.toString()).toContain("Another local editor");
		} finally {
			holder.kill("SIGKILL");
			await holder.exited;
		}
		await start("first", "--no-update");
		expect(await cached()).toEqual([first]);
		await fs.writeFile(path.join(web, "VERSION"), "next");
		const next = commit("Editor update");
		expect(await start("first", "--no-update")).not.toContain("Updated bopencut");
		expect(git(clone, "rev-parse", "HEAD")).toBe(first);
		const localEdit = path.join(clone, "local-edit.txt");
		await fs.writeFile(localEdit, "keep this edit");
		expect(await start("first")).toContain("the checkout has local changes");
		expect(await fs.readFile(localEdit, "utf8")).toBe("keep this edit");
		await fs.unlink(localEdit);
		expect(await start("next")).toContain("Updated bopencut");
		expect(git(clone, "rev-parse", "HEAD")).toBe(next);
		expect(await fs.readFile(path.join(state, "installed-commit"), "utf8")).toBe(first);
		expect(await cached()).toEqual([first, next].sort());
		await fs.writeFile(path.join(web, "VERSION"), "broken");
		const broken = commit("Broken editor update");
		expect(await start("next")).toContain("Update skipped: Editor build failed");
		expect(git(clone, "rev-parse", "HEAD")).toBe(next);
		const lockfile = path.join(origin, "bun.lock");
		const validLockfile = await fs.readFile(lockfile);
		await fs.writeFile(lockfile, "invalid lockfile\n");
		const badLockfile = commit("Broken dependency update");
		expect(await start("next")).toContain("Update skipped: Dependency installation failed");
		expect(git(clone, "rev-parse", "HEAD")).toBe(next);
		await fs.writeFile(lockfile, validLockfile);
		await fs.writeFile(path.join(web, "VERSION"), "bad-server");
		const badServer = commit("Broken runtime update");
		expect(await start("next")).toContain("Update skipped: The editor did not start");
		expect(git(clone, "rev-parse", "HEAD")).toBe(next);
		expect(await cached()).toEqual([first, next].sort());
		await fs.writeFile(path.join(web, "VERSION"), "newest");
		const newest = commit("Next working update");
		expect(await start("newest")).toContain("Updated bopencut");
		expect(git(clone, "rev-parse", "HEAD")).toBe(newest);
		expect(await cached()).toEqual([next, newest].sort());
		await fs.mkdir(lock);
		await start("newest", "--no-update");
		expect(await cached()).toEqual([next, newest].sort());
		const log = (await fs.readFile(path.join(root, ".bopencut-updates.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(log).toMatchObject([
			{ old: first, next, result: "skipped: the checkout has local changes" },
			{ old: first, next, result: "updated" },
			{ old: next, next: broken, result: "skipped: Editor build failed" },
			{ old: next, next: badLockfile, result: "skipped: Dependency installation failed" },
			{ old: next, next: badServer, result: "skipped: The editor did not start" },
			{ old: next, next: newest, result: "updated" },
		]);
		expect(await fs.readdir(data)).toEqual(["original.txt"]);
		expect(await fs.readFile(path.join(data, "original.txt"), "utf8")).toBe("keep this file");
	} finally {
		// Only this test's temporary repositories are removed.
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
