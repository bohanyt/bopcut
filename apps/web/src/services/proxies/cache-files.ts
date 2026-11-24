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

type Lock = { name: string; generation: number };
type Claim = Lock & { record: string };
const claims = new Map<string, Claim>();
const incompleteLockAge = 10_000;
const bootClockMargin = 10 * 60_000;

async function generations(dir: string) {
	const names = await fs.readdir(dir).catch(() => undefined);
	return names?.flatMap(name => {
		const match = /^writer-([1-9]\d*)\.lock$/i.exec(name);
		const generation = Number(match?.[1]);
		return Number.isSafeInteger(generation) ? [{ name, generation }] : [];
	});
}

const highest = (values: Lock[]) => values.reduce((latest, lock) => Math.max(latest, lock.generation), 0);
const isHighest = (values: Lock[], lock: Lock) => values.some(entry => entry.name === lock.name) &&
	values.every(entry => entry.generation < lock.generation || entry.name === lock.name);

async function readLock(file: string) {
	if (await proxyFile(file)) return fs.readFile(file, "utf8").catch(() => undefined);
}

async function staleLock(file: string, now: number) {
	const stat = await proxyFile(file);
	if (!stat) return false;
	let previous: { pid: number; token: string; startedAt: number } | undefined;
	try {
		const parsed = JSON.parse(await fs.readFile(file, "utf8"));
		if (parsed && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 &&
			typeof parsed.token === "string" && Number.isFinite(parsed.startedAt)) previous = parsed;
	} catch { /* An incomplete record may still be in the process of being written. */ }
	if (!previous) return now - stat.mtimeMs >= incompleteLockAge;
	if (previous.startedAt < now - uptime() * 1000 - bootClockMargin) return true;
	try { process.kill(previous.pid, 0); return false; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export async function ownsProxyWriter(dir: string) {
	const claim = claims.get(dir);
	if (!claim || await readLock(path.join(dir, claim.name)) !== claim.record) return false;
	const values = await generations(dir);
	return !!values && isHighest(values, claim);
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
	const generation = latest + 1;
	if (!Number.isSafeInteger(generation)) return false;
	const now = Date.now();
	for (const lock of values) {
		if (lock.generation === latest && !await staleLock(path.join(dir, lock.name), now)) return false;
	}
	const claim = { name: `writer-${generation}.lock`, generation,
		record: JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: Date.now() }) };
	const file = path.join(dir, claim.name);
	try { await fs.writeFile(file, claim.record, { flag: "wx" }); }
	catch (error) {
		const failure = error as NodeJS.ErrnoException;
		if (failure.code === "EEXIST" || denied(failure)) return false;
		throw error;
	}
	const updated = await generations(dir);
	if (!updated) {
		if (await readLock(file) === claim.record) await fs.unlink(file).catch(() => {});
		return false;
	}
	if (!isHighest(updated, claim)) {
		if (await readLock(file) === claim.record) await fs.unlink(file).catch(() => {});
		return false;
	}
	claims.set(dir, claim);
	for (const older of updated) {
		if (older.generation >= generation) continue;
		const oldFile = path.join(dir, older.name);
		if (!await proxyFile(oldFile)) continue;
		if (!await ownsProxyWriter(dir)) return false;
		await fs.unlink(oldFile).catch(() => {});
	}
	return ownsProxyWriter(dir);
}
