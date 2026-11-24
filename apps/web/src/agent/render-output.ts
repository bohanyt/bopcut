import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { ownedJobName, recoverScratch } from "./job-scratch";
import path from "node:path";
import { atomicWrite, dataRoot, readJson, renameWithRetry } from "@/services/storage/server/files";

const identity = async (file: string) => {
	const stat = await fs.lstat(file, { bigint: true });
	return `${stat.dev}:${stat.ino}`;
};

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
const jobName = /^(cli-[a-f0-9-]{36})(?:\.([a-f0-9]{16})\.([1-9]\d*))?$/;

export const renderJobDir = (workspace: string, rev: string) =>
	path.join(renderJobsDir(workspace), ownedJobName(rev));

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
	const kind = output.file === `frames/${rev}` ? "frames" : output.file === `views/${rev}.png` ? "view" : "export";
	if (kind === "export" && !/^exports\/[^/\\]+\.(?:mp4|webm)$/.test(output.file)) throw new Error("Invalid render output record.");
	const name = `${kind}-result.json`;
	const committed = await readJson(path.join(scratch, name));
	const file = path.join(workspace, output.file);
	const published = committed?.rev === rev && (kind !== "frames" ? committed.file === output.file :
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
export function recoverRenderJobs(workspace: string) {
	return recoverScratch(renderJobsDir(workspace), jobName, (scratch) => removeRenderJob(workspace, scratch));
}
