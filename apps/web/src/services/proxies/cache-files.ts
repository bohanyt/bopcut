import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { uptime } from "node:os";
import path from "node:path";
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

type Claim = { generation: bigint; record: string };
const claims = new Map<string, Claim>();
const lockPath = (dir: string, generation: bigint) => path.join(dir, `writer-${generation}.lock`);

async function generations(dir: string) {
	const names = await fs.readdir(dir).catch(() => undefined);
	return names?.flatMap(name => {
		const match = /^writer-([1-9]\d*)\.lock$/.exec(name);
		return match ? [BigInt(match[1])] : [];
	});
}

const highest = (values: bigint[]) => values.reduce((latest, generation) => generation > latest ? generation : latest, BigInt(0));

async function readLock(dir: string, generation: bigint) {
	const file = lockPath(dir, generation);
	if (await proxyFile(file)) return fs.readFile(file, "utf8").catch(() => undefined);
}

export async function ownsProxyWriter(dir: string) {
	const claim = claims.get(dir);
	if (!claim || await readLock(dir, claim.generation) !== claim.record) return false;
	const values = await generations(dir);
	return !!values && highest(values) === claim.generation;
}

export class ProxyWriterLost extends Error {}

export async function requireProxyWriter(dir: string) {
	if (!await ownsProxyWriter(dir)) throw new ProxyWriterLost();
}

export async function acquireProxyWriter(dir: string): Promise<boolean> {
	if (await ownsProxyWriter(dir)) return true;
	const values = await generations(dir);
	if (!values) return false;
	const latest = highest(values);
	if (latest > BigInt(0)) {
		const raw = await readLock(dir, latest);
		if (!raw) return false;
		let previous: { pid: number; token: string; startedAt: number };
		try {
			previous = JSON.parse(raw);
			if (!previous || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 ||
				typeof previous.token !== "string" || !Number.isFinite(previous.startedAt)) return false;
		} catch { return false; }
		if (previous.startedAt >= Date.now() - uptime() * 1000) {
			try { process.kill(previous.pid, 0); return false; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
		}
	}
	const generation = latest + BigInt(1);
	const record = JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: Date.now() });
	const file = lockPath(dir, generation);
	try { await fs.writeFile(file, record, { flag: "wx" }); }
	catch (error) {
		const failure = error as NodeJS.ErrnoException;
		if (failure.code === "EEXIST" || denied(failure)) return false;
		throw error;
	}
	const updated = await generations(dir);
	if (!updated) return false;
	if (highest(updated) !== generation) {
		if (await readLock(dir, generation) === record) await fs.unlink(file).catch(() => {});
		return false;
	}
	claims.set(dir, { generation, record });
	for (const older of updated) {
		if (older >= generation) continue;
		const oldFile = lockPath(dir, older);
		if (!await proxyFile(oldFile)) continue;
		if (!await ownsProxyWriter(dir)) return false;
		await fs.unlink(oldFile).catch(() => {});
	}
	return ownsProxyWriter(dir);
}
