import { promises as fs } from "node:fs";
import path from "node:path";
import { dataRoot } from "@/services/storage/server/files";

export async function proxyDirectory(create = false): Promise<string | undefined> {
	const root = dataRoot();
	if (create) await fs.mkdir(root, { recursive: true });
	const real = await fs.realpath(root).catch(() => undefined);
	if (!real) return;
	const dir = path.join(real, "proxies");
	if (create) await fs.mkdir(dir).catch(error => {
		if (error.code !== "EEXIST") throw error;
	});
	const entry = await fs.lstat(dir).catch(() => undefined);
	if (entry?.isDirectory() && !entry.isSymbolicLink() && await fs.realpath(dir) === dir) return dir;
}

export async function proxyFile(file: string) {
	const stat = await fs.lstat(file).catch(() => undefined);
	return stat?.isFile() && stat.nlink === 1 ? stat : undefined;
}

const lockName = ".writer";
export async function ownsProxyWriter(dir: string) {
	const lock = path.join(dir, lockName);
	return !!await proxyFile(lock) && (await fs.readFile(lock, "utf8").catch(() => "")) === String(process.pid);
}

export async function acquireProxyWriter(dir: string): Promise<boolean> {
	const lock = path.join(dir, lockName);
	const claim = async () => {
		try {
			await fs.writeFile(lock, String(process.pid), { flag: "wx" });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return false;
		}
	};
	if (await claim()) return true;
	const stat = await proxyFile(lock);
	if (!stat) return false;
	const record = await fs.readFile(lock, "utf8").catch(() => "");
	const pid = Number(record);
	if (pid === process.pid) return true;
	if (Number.isSafeInteger(pid) && pid > 0) {
		try { process.kill(pid, 0); return false; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
	} else if (Date.now() - stat.mtimeMs < 10_000) return false;
	const current = await proxyFile(lock);
	if (!current || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) return false;
	await fs.unlink(lock).catch(() => {});
	return claim();
}
