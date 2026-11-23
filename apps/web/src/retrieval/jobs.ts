import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ownedJobName, recoverScratch } from "@/agent/job-scratch";
import { renameWithRetry } from "@/services/storage/server/files";
import { RetrievalError } from "./server-errors";

export class Cancelled extends RetrievalError {
	constructor(stage: string) {
		super("cancelled during " + stage);
	}
}

export function checkCancelled(signal: AbortSignal | undefined, stage: string) {
	if (signal?.aborted) throw signal.reason instanceof Cancelled ? signal.reason : new Cancelled(stage);
}

const scratchName = /^([a-f0-9-]{36})(?:\.([a-f0-9]{16})\.([1-9]\d*))?$/;
async function remove(scratch: string) {
	try {
		await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 });
	} catch (error) {
		const id = path.basename(scratch).split(".", 1)[0];
		await renameWithRetry(scratch, path.join(path.dirname(scratch), id)).catch(() => {});
		throw error;
	}
}

export async function withScratch<T>(
	root: string, signal: AbortSignal | undefined, work: (scratch: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
	signal ??= new AbortController().signal;
	checkCancelled(signal, "preparation");
	const dir = path.join(root, ".retrieval-jobs");
	await recoverScratch(dir, scratchName, remove);
	await fs.mkdir(dir, { recursive: true });
	const id = randomUUID();
	const scratch = path.join(dir, ownedJobName(id));
	checkCancelled(signal, "preparation");
	await fs.mkdir(scratch);
	try {
		const result = await work(scratch, signal);
		checkCancelled(signal, "cleanup");
		return result;
	} catch (error) {
		if (error instanceof Cancelled) throw error;
		checkCancelled(signal, "retrieval");
		throw error;
	} finally {
		await remove(scratch);
	}
}

export function cacheTarget(legacyFile: string, legacyMeta: string) {
	const dir = legacyMeta.replace(/\.json$/, ".asset");
	return { media: path.join(dir, path.basename(legacyFile)), meta: path.join(dir, path.basename(legacyMeta)) };
}

export async function reusePublished<T>(lookup: () => Promise<T | undefined>): Promise<T> {
	const cached = await lookup();
	if (!cached) throw new RetrievalError("the committed cache entry is unavailable; retry the request");
	return cached;
}

/** The completed directory is the commit record. An existing winner's directory cannot be replaced. */
export async function publishMedia(
	source: string, target: string, signal: AbortSignal, metadata?: { file: string; value: unknown },
): Promise<boolean> {
	checkCancelled(signal, "publication");
	try {
		if (!metadata) {
			await fs.mkdir(path.dirname(target), { recursive: true });
			await renameWithRetry(source, target, signal);
			return true;
		}
		const destination = path.dirname(target);
		const staged = path.join(path.dirname(source), "publish");
		await fs.mkdir(staged);
		await fs.rename(source, path.join(staged, path.basename(target)));
		await fs.writeFile(path.join(staged, path.basename(metadata.file)), JSON.stringify(metadata.value, null, 1));
		await fs.mkdir(path.dirname(destination), { recursive: true });
		try {
			signal.throwIfAborted();
			await fs.rename(staged, destination);
			return true;
		} catch (error) {
			checkCancelled(signal, "publication");
			if (await fs.stat(metadata.file).then((stat) => stat.isFile(), () => false)) return false;
			throw error;
		}
	} catch (error) {
		checkCancelled(signal, "publication");
		throw error;
	}
}

export function sharedJob<T>() {
	type Job = { controller: AbortController; promise: Promise<T>; waiters: number };
	const jobs = new Map<string, Job>();
	return async function run(key: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
		checkCancelled(signal, "preparation");
		let job = jobs.get(key);
		if (job?.controller.signal.aborted) {
			await job.promise.catch(() => {});
			return run(key, signal, work);
		}
		if (!job) {
			const controller = new AbortController();
			const promise = Promise.resolve().then(() => work(controller.signal)).finally(() => jobs.delete(key));
			job = { controller, promise, waiters: 0 };
			jobs.set(key, job);
		}
		const running = job;
		running.waiters++;
		return new Promise<T>((resolve, reject) => {
			let left = false;
			const leave = () => {
				left = true;
				running.waiters--;
				signal?.removeEventListener("abort", abort);
			};
			const abort = () => {
				leave();
				if (running.waiters) reject(new Cancelled("shared retrieval"));
				else {
					running.controller.abort();
					running.promise.then(
						() => reject(new Cancelled("cleanup")),
						(error) => reject(error instanceof Cancelled ? error : new Cancelled("retrieval")),
					);
				}
			};
			signal?.addEventListener("abort", abort, { once: true });
			running.promise.then(
				(value) => { if (!left) { leave(); resolve(value); } },
				(error) => { if (!left) { leave(); reject(error); } },
			);
		});
	};
}
