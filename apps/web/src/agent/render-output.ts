import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { atomicWrite, dataRoot, readJson, renameWithRetry } from "@/services/storage/server/files";

const identity = async (file: string) => {
	const stat = await fs.lstat(file, { bigint: true });
	return `${stat.dev}:${stat.ino}`;
};
const exists = (file: string) => fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
	if (error.code === "ENOENT") return false;
	throw error;
});

export async function profileDirectory(workspace: string, data = dataRoot()) {
	for (const root of new Set([data, workspace])) {
		const profile = path.join(root, ".render-browser");
		try {
			await fs.mkdir(profile, { recursive: true });
			const probe = path.join(profile, `.probe-${randomUUID()}`);
			await fs.writeFile(probe, "", { flag: "wx" });
			await fs.rm(probe);
			return profile;
		} catch (error) {
			if (root === workspace) throw error;
		}
	}
	throw new Error("Could not prepare the hidden browser profile.");
}

export const renderJobsDir = (workspace: string) => path.join(workspace, ".render-jobs");
const localHost = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
const jobName = /^(cli-[a-f0-9-]{36})(?:\.([a-f0-9]{16})\.([1-9]\d*))?$/;

export const renderJobDir = (workspace: string, rev: string) =>
	path.join(renderJobsDir(workspace), `${rev}.${localHost}.${process.pid}`);

function isAbandoned(host: string | undefined, owner: string | undefined) {
	if (!owner) return true;
	const pid = Number(owner);
	if (host !== localHost || pid > 0x7fffffff) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export async function recordOutput(workspace: string, scratch: string, target: string, source: string) {
	await atomicWrite(path.join(scratch, "output.json"), JSON.stringify({
		file: path.relative(workspace, target).split(path.sep).join("/"),
		identity: await identity(source),
	}));
}

const jobRevision = (scratch: string) => path.basename(scratch).split(".", 1)[0];

export async function rollbackOutput(workspace: string, scratch: string) {
	const rev = jobRevision(scratch);
	const output = await readJson(path.join(scratch, "output.json"));
	if (!output) return;
	const kind = output.file === `frames/${rev}` ? "frames" : "export";
	if (kind === "export" && !/^exports\/[^/\\]+\.(?:mp4|webm)$/.test(output.file)) throw new Error("Invalid render output record.");
	const name = `${kind}-result.json`;
	const committed = await readJson(path.join(scratch, name));
	const file = path.join(workspace, output.file);
	const published = committed?.rev === rev && (kind === "export" ? committed.file === output.file :
		Array.isArray(committed.files) && committed.files.some((frame: unknown) => typeof frame === "string" && frame.startsWith(`${output.file}/`)));
	const actual = published ? null : await identity(file).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (actual === output.identity) {
		await fs.rm(file, { recursive: kind === "frames", force: true });
	}
	await fs.rm(path.join(scratch, "output.json"), { force: true });
}

export async function removeRenderJob(workspace: string, scratch: string) {
	try {
		await rollbackOutput(workspace, scratch);
		await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 });
	} catch (error) {
		// Release ownership once all writes have ended so the next render can retry cleanup.
		await renameWithRetry(scratch, path.join(renderJobsDir(workspace), jobRevision(scratch))).catch(() => {});
		throw error;
	}
}

/** Reclaim abandoned jobs before creating a new job, even when servers share a workspace. */
export async function recoverRenderJobs(workspace: string) {
	const dir = renderJobsDir(workspace);
	if (!(await exists(dir))) return;
	if (!(await fs.lstat(dir)).isDirectory()) throw new Error("The render jobs folder must be a directory.");
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const match = entry.isDirectory() && jobName.exec(entry.name);
		if (!match || !isAbandoned(match[2], match[3])) continue;
		const abandoned = path.join(dir, entry.name);
		const scratch = renderJobDir(workspace, match[1]);
		try {
			// Claim the directory before touching outputs, so only one process can recover it.
			await fs.rename(abandoned, scratch);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		await removeRenderJob(workspace, scratch);
	}
}
