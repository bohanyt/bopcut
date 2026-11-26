import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const web = "apps/web";
const host = "127.0.0.1";
const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"];
const bun = process.versions.bun ? process.execPath : "bun";
const runtimeFlags = process.versions.bun ? ["--no-env-file"] : [];
const args = process.argv.slice(2);
const portOption = args.find((argument) => argument.startsWith("--port="));
const port = Number(portOption?.slice(7) ?? process.env.BOPENCUT_PORT ?? 3000);
const update = !args.includes("--no-update") && process.env.BOPENCUT_AUTO_UPDATE !== "0";
const childProcesses = new Set();
let interrupted = false;
let dataRoot = process.env.BOPENCUT_DATA
	? path.resolve(repo, web, process.env.BOPENCUT_DATA)
	: path.resolve(repo, "workspace");

function git(args, cwd = repo) {
	try {
		return execFileSync("git", args, {
			cwd, encoding: "utf8", windowsHide: true, timeout: 30_000,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		throw new Error(error.stderr?.trim().split(/\r?\n/).at(-1) || `git ${args[0]} failed`, { cause: error });
	}
}

async function exists(file) {
	return fs.stat(file).then(() => true, () => false);
}

function child(command, args, options) {
	if (interrupted) throw new Error("Startup interrupted");
	const process = spawn(command, args, { ...options, stdio: "inherit", windowsHide: true, detached: processPlatform !== "win32" });
	childProcesses.add(process);
	const done = new Promise((resolve, reject) => {
		process.once("exit", (code) => resolve(code ?? 1));
		process.once("error", reject);
	}).finally(() => childProcesses.delete(process));
	return { process, done };
}

const processPlatform = process.platform;
function stopChild(child) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
	try {
		if (processPlatform === "win32") {
			execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
		} else process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill();
	}
}

async function run(command, args, { label, ...options }) {
	if (await child(command, args, options).done !== 0) throw new Error(`${label} failed`);
}

const listening = () => new Promise((resolve) => {
	const socket = net.createServer();
	socket.once("error", () => resolve(true));
	socket.listen(port, host, () => socket.close(() => resolve(false)));
});

async function syncEnv(destination, source = path.join(repo, web)) {
	for (const name of envFiles) {
		const from = path.join(source, name);
		const to = path.join(destination, name);
		if (await exists(from)) await fs.copyFile(from, to);
		else if (await exists(to)) await fs.unlink(to);
	}
}

async function runtimeEnv(server) {
	const original = path.join(repo, web);
	const env = { ...process.env, NODE_ENV: "production" };
	const folders = ["BOPENCUT_DATA", "AGENT_WORKSPACE", "AGENT_FILES_ROOT"];
	if ((await Promise.all(envFiles.map((name) => exists(path.join(original, name))))).some(Boolean)) {
		// Next alone expands dotenv values. Run its loader outside the launcher so it cannot alter later builds.
		const app = createRequire(server);
		const loader = createRequire(app.resolve("next/package.json")).resolve("@next/env");
		const readFolders = `require(process.argv[1]).loadEnvConfig(process.argv[2], false, { info() {}, error() {} });
			console.log(JSON.stringify(${JSON.stringify(folders)}.map((key) => process.env[key])));`;
		const values = JSON.parse(execFileSync(process.execPath, [...runtimeFlags, "-e", readFolders, loader, original], {
			env, encoding: "utf8", windowsHide: true,
		}));
		for (const [index, key] of folders.entries()) if (values[index]) env[key] = values[index];
	}
	const defaultWorkspace = path.join(repo, "workspace");
	for (const key of folders) {
		env[key] = env[key] ? path.resolve(original, env[key]) : key === "AGENT_FILES_ROOT" ? env.AGENT_WORKSPACE : defaultWorkspace;
	}
	dataRoot = env.BOPENCUT_DATA;
	return { ...env, HOSTNAME: host, PORT: String(port) };
}

async function serverFile(build) {
	for (const file of [path.join(build, web, "server.js"), path.join(build, "server.js")]) {
		if (await exists(file)) return file;
	}
	return null;
}

function within(root, target) {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== "ESRCH";
	}
}

async function removeEmptyDirectory(directory) {
	try {
		await fs.rmdir(directory);
	} catch (error) {
		if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
	}
}

async function lockStartup(state) {
	const lock = path.join(state, "starting");
	const claim = await fs.mkdtemp(path.join(state, "starting-"));
	const owner = `owner-${process.pid}-${path.basename(claim)}`;
	try {
		await fs.writeFile(path.join(claim, owner), "");
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await fs.rename(claim, lock);
				return async () => {
					await fs.unlink(path.join(lock, owner));
					await removeEmptyDirectory(lock);
				};
			} catch (error) {
				if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
			}
			const entries = await fs.readdir(lock).catch((error) => {
				if (error.code !== "ENOENT") throw error;
				return [];
			});
			for (const name of entries) {
				const pid = /^owner-([1-9]\d*)-starting-[\w-]+$/.exec(name)?.[1];
				if (!pid || isAlive(Number(pid))) throw new Error("Another local editor is running or starting");
				// Each claim has a unique marker. A stale claim can never unlink a newer owner.
				await fs.unlink(path.join(lock, name)).catch((error) => { if (error.code !== "ENOENT") throw error; });
			}
			await removeEmptyDirectory(lock);
		}
		throw new Error("Could not lock the local editor");
	} finally {
		await fs.unlink(path.join(claim, owner)).catch((error) => { if (error.code !== "ENOENT") throw error; });
		await removeEmptyDirectory(claim);
	}
}

async function deleteBuild(directory) {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) await deleteBuild(file);
		else await fs.unlink(file);
	}
	await fs.rmdir(directory);
}

async function pruneBuilds(state, current, previous) {
	const directory = path.join(state, "builds");
	const previousFile = path.join(state, "previous-build");
	try {
		const expected = path.join(await fs.realpath(path.dirname(state)), path.basename(state), "builds");
		if (await fs.realpath(directory) !== expected) throw new Error("The build cache path has changed");
		if (previous) await fs.writeFile(previousFile, previous);
		else previous = await fs.readFile(previousFile, "utf8").catch(() => "");
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const name = entry.name;
			if (!entry.isDirectory() || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(name) || name === current || name === previous) continue;
			await deleteBuild(path.join(directory, name));
		}
	} catch (error) {
		console.warn(`Could not clean the local build cache: ${error.message}`);
	}
}

async function copyTracedAliases(directory, source, output) {
	if (!await exists(directory)) return;
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			await copyTracedAliases(file, source, output);
		} else if (entry.isSymbolicLink()) {
			const link = await fs.readlink(file);
			const target = path.resolve(directory, link);
			if (!path.isAbsolute(link) && within(output, target)) continue;
			if (!within(source, target)) throw new Error(`The standalone build links outside the checkout: ${entry.name}`);
			const traced = within(output, target) ? target : path.join(output, path.relative(source, target));
			await fs.unlink(file);
			await fs.cp(traced, file, { recursive: true });
		}
	}
}

async function buildCommit(state, commit) {
	const builds = path.join(state, "builds");
	const build = path.join(builds, commit);
	const existing = await serverFile(build);
	if (existing) return existing;
	const source = path.join(state, "source");
	if (await exists(path.join(source, ".git"))) {
		if (git(["rev-parse", "HEAD"], source) !== commit) git(["switch", "--detach", commit], source);
	} else git(["worktree", "add", "--detach", source, commit]);
	const installedFile = path.join(state, "installed-commit");
	const installed = await fs.readFile(installedFile, "utf8").catch(() => "");
	const dependencies = ["bun.lock", "package.json", ":(glob)**/package.json", ":(glob)rust/wasm/**/*.tgz"];
	const changed = !installed || git(["diff", "--name-only", installed, commit, "--", ...dependencies], source);
	if (changed || !await exists(path.join(source, "node_modules"))) {
		if (installed) await fs.unlink(installedFile);
		// Hoisting keeps traced dependencies from holding links to this mutable checkout.
		await run(bun, ["--no-env-file", "install", "--frozen-lockfile", "--linker=hoisted"], { cwd: source, label: "Dependency installation" });
		await fs.writeFile(installedFile, commit);
	}
	const app = path.join(source, web);
	await syncEnv(app);
	await run(bun, ["--no-env-file", "run", "build"], {
		cwd: app, label: "Editor build", env: { ...process.env, NODE_ENV: "production", BOPENCUT_STANDALONE: "1" },
	});
	const output = path.join(app, ".next", "standalone");
	const server = await serverFile(output);
	if (!server) throw new Error("The build did not produce a standalone server");
	// Turbopack's external package aliases must also survive a failed install in the source checkout.
	await copyTracedAliases(path.join(path.dirname(server), ".next", "node_modules"), source, output);
	const publicDir = path.join(app, "public");
	if (await exists(publicDir)) await fs.cp(publicDir, path.join(path.dirname(server), "public"), { recursive: true });
	const staticDir = path.join(app, ".next", "static");
	if (await exists(staticDir)) await fs.cp(staticDir, path.join(path.dirname(server), ".next", "static"), { recursive: true });
	await fs.mkdir(builds, { recursive: true });
	await fs.rename(output, build);
	return path.join(build, path.relative(output, server));
}

async function startServer(server) {
	const cwd = path.dirname(server);
	const env = await runtimeEnv(server);
	await syncEnv(cwd);
	const running = child(process.execPath, [...runtimeFlags, server], { cwd, env });
	const healthy = (async () => {
		for (let attempt = 0; attempt < 100 && !running.process.exitCode && !interrupted; attempt++) {
			try {
				const response = await fetch(`http://${host}:${port}/projects`, { redirect: "manual", signal: AbortSignal.timeout(500) });
				await response.body?.cancel();
				if (response.ok) return true;
			} catch { /* Wait for the server to start listening. */ }
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	})();
	try {
		if (await Promise.race([healthy, running.done.then(() => false)])) return running;
		throw new Error("The editor did not start");
	} catch (error) {
		stopChild(running.process);
		await running.done.catch(() => {});
		throw error;
	}
}

async function record(old, next, result) {
	const log = path.join(path.dirname(dataRoot), ".bopencut-updates.jsonl");
	try {
		const previous = (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).slice(-49);
		await fs.writeFile(log, [...previous, JSON.stringify({ time: new Date().toISOString(), old, next, result })].join("\n") + "\n");
	} catch (error) {
		console.warn(`Could not write the update log: ${error.message}`);
	}
}

async function main() {
	if (!Number.isInteger(port) || port < 1 || port > 65535 || args.some((arg) => arg !== "--no-update" && arg !== portOption)) {
		throw new Error("Use start-local.mjs [--no-update] [--port=NUMBER]");
	}
	if (await listening()) {
		console.log(`The editor port ${port} is in use. Updates are checked after the editor closes.`);
		return 0;
	}
	const state = path.join(git(["rev-parse", "--absolute-git-dir"]), "bopencut-local");
	await fs.mkdir(state, { recursive: true });
	const release = await lockStartup(state);
	let running;
	try {
		const current = git(["rev-parse", "HEAD"]);
		let next = current;
		if (update) {
			try {
				git(["fetch", "origin", "main"]);
				next = git(["rev-parse", "FETCH_HEAD"]);
				if (next !== current) {
					if (git(["status", "--porcelain"])) throw new Error("the checkout has local changes");
					const branch = git(["branch", "--show-current"]);
					if (branch && branch !== "main") throw new Error("the checked out branch is not main");
					if (git(["merge-base", current, next]) !== current) throw new Error("origin/main is not a fast-forward");
					const server = await buildCommit(state, next);
					if (await listening()) throw new Error(`port ${port} became busy`);
					running = await startServer(server);
					try {
						if (git(["status", "--porcelain"]) || git(["rev-parse", "HEAD"]) !== current) throw new Error("the checkout changed during the build");
						if (git(["diff", "--name-only", current, next, "--", `${web}/src/services/storage/migrations`])) {
							console.warn("This update changes project data migrations. Projects opened with it may require the newer editor on other machines.");
						}
						git(branch ? ["merge", "--ff-only", next] : ["switch", "--detach", next]);
					} catch (error) {
						stopChild(running.process);
						await running.done.catch(() => {});
						running = undefined;
						throw error;
					}
					console.log(`Updated bopencut to ${next.slice(0, 12)}.`);
					await record(current, next, "updated");
				}
			} catch (error) {
				console.warn(`Update skipped: ${error.message}. Keeping ${current.slice(0, 12)}.`);
				try {
					const previous = await serverFile(path.join(state, "builds", current));
					if (previous) await runtimeEnv(previous);
				} catch { /* Use the default log location if the previous server is unavailable. */ }
				await record(current, next, `skipped: ${error.message}`);
			}
		}
		if (!running) {
			if (await listening()) throw new Error(`Port ${port} is in use`);
			running = await startServer(await buildCommit(state, current));
			await pruneBuilds(state, current);
		} else {
			await pruneBuilds(state, next, current);
		}
		console.log(`Open http://${host}:${port}/projects`);
		return await running.done;
	} finally {
		await release();
	}
}

function stop() {
	interrupted = true;
	for (const running of childProcesses) stopChild(running);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
	const status = await main();
	process.exitCode = interrupted ? 0 : status;
} catch (error) {
	stop();
	console.error(error.message);
	process.exitCode = 1;
}
