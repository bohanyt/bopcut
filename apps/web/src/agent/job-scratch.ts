import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

const localHost = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
export const ownedJobName = (id: string) => id + "." + localHost + "." + process.pid;

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

/** Claim before cleanup so two processes sharing a root cannot recover the same job. */
export async function recoverScratch(dir: string, name: RegExp, remove: (scratch: string) => Promise<void>) {
	const stat = await fs.lstat(dir).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	if (!stat) return;
	if (!stat.isDirectory()) throw new Error("The jobs folder must be a directory.");
	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		const match = entry.isDirectory() && name.exec(entry.name);
		if (!match || !isAbandoned(match[2], match[3])) continue;
		const scratch = path.join(dir, ownedJobName(match[1]));
		try {
			await fs.rename(path.join(dir, entry.name), scratch);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		await remove(scratch);
	}
}
