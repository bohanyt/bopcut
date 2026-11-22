import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWrite, dataRoot, readJson } from "@/services/storage/server/files";

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

export async function recordOutput(workspace: string, scratch: string, target: string, source: string) {
	await atomicWrite(path.join(scratch, "output.json"), JSON.stringify({
		file: path.relative(workspace, target).split(path.sep).join("/"),
		identity: await identity(source),
	}));
}

export async function rollbackOutput(workspace: string, scratch: string) {
	const rev = path.basename(scratch);
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

/** Runs while the CLI holds the reservation, before it creates a new job. */
export async function recoverRenderJobs(workspace: string) {
	const dir = renderJobsDir(workspace);
	if (!(await exists(dir))) return;
	if (!(await fs.lstat(dir)).isDirectory()) throw new Error("The render jobs folder must be a directory.");
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^cli-[a-f0-9-]{36}$/.test(entry.name)) continue;
		const scratch = path.join(dir, entry.name);
		await rollbackOutput(workspace, scratch);
		await fs.rm(scratch, { recursive: true, force: true });
	}
}
