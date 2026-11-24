import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { dataRoot } from "@/services/storage/server/files";

function denied(error: NodeJS.ErrnoException) {
	return error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS";
}

export async function proxyDirectory(create = false): Promise<string | undefined> {
	const root = dataRoot();
	if (create) await fs.mkdir(root, { recursive: true }).catch(error => {
		if (!denied(error)) throw error;
	});
	const real = await fs.realpath(root).catch(() => undefined);
	if (!real) return;
	const dir = path.join(real, "proxies");
	if (create) await fs.mkdir(dir).catch(error => {
		if (error.code !== "EEXIST" && !denied(error)) throw error;
	});
	const entry = await fs.lstat(dir).catch(() => undefined);
	if (entry?.isDirectory() && !entry.isSymbolicLink() && await fs.realpath(dir).catch(() => undefined) === dir) return dir;
}

export async function proxyFile(file: string) {
	const stat = await fs.lstat(file).catch(() => undefined);
	return stat?.isFile() && stat.nlink === 1 ? stat : undefined;
}

const lockName = ".writer";
const claims = new Map<string, string>();
export async function ownsProxyWriter(dir: string) {
	const lock = path.join(dir, lockName);
	const claim = claims.get(dir);
	return !!claim && !!await proxyFile(lock) && (await fs.readFile(lock, "utf8").catch(() => "")) === claim;
}

export class ProxyWriterLost extends Error {}

export async function requireProxyWriter(dir: string) {
	if (!await ownsProxyWriter(dir)) throw new ProxyWriterLost();
}

export async function acquireProxyWriter(dir: string): Promise<boolean> {
	if (await ownsProxyWriter(dir)) return true;
	const lock = path.join(dir, lockName);
	const record = process.pid + ":" + randomUUID();
	const claim = async () => {
		try {
			await fs.writeFile(lock, record, { flag: "wx" });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") return "occupied";
			if (denied(error as NodeJS.ErrnoException)) return false;
			throw error;
		}
		await sleep(250);
		if (!await proxyFile(lock) || await fs.readFile(lock, "utf8").catch(() => "") !== record) return false;
		claims.set(dir, record);
		return true;
	};
	const initial = await claim();
	if (initial !== "occupied") return initial;
	const stat = await proxyFile(lock);
	if (!stat) return false;
	const previous = await fs.readFile(lock, "utf8").catch(() => "");
	const pid = Number(previous.split(":")[0]);
	if (Number.isSafeInteger(pid) && pid > 0) {
		try { process.kill(pid, 0); return false; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
	} else if (Date.now() - stat.mtimeMs < 10_000) return false;
	const current = await proxyFile(lock);
	if (!current || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs ||
		await fs.readFile(lock, "utf8").catch(() => "") !== previous) return false;
	await fs.unlink(lock).catch(() => {});
	return await claim() === true;
}
