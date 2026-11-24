import path from "node:path";
import { promises as fs, createWriteStream } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function safeId(id: string): string {
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid ID");
	return id;
}

export function dataRoot(): string {
	return path.resolve(
		process.env.BOPENCUT_DATA ??
			path.join(process.cwd(), "..", "..", "workspace"),
	);
}

export function projectDir(id: string): string {
	return path.join(dataRoot(), "projects", safeId(id));
}

// Windows refuses to replace or open a file that another handle (a reader, an indexer, a virus
// scanner) holds for a moment: EPERM/EACCES/EBUSY. Those clear within milliseconds, so retry.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
export const isTransientFsError = (error: unknown) =>
	TRANSIENT.has((error as NodeJS.ErrnoException)?.code ?? "");

/** Runs `action`, retrying transient file-lock errors with exponential backoff (about 2.5 s in total). */
export async function retryTransient<T>(
	action: () => Promise<T>,
	{
		attempts = 9,
		delayMs = 10,
		sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	}: {
		attempts?: number;
		delayMs?: number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await action();
		} catch (error) {
			if (attempt >= attempts || !isTransientFsError(error)) throw error;
			await sleep(delayMs * 2 ** (attempt - 1));
		}
	}
}

export const renameWithRetry = (from: string, to: string, signal?: AbortSignal) =>
	retryTransient(() => {
		signal?.throwIfAborted();
		return fs.rename(from, to);
	});

// Writes to one file run one after another (two renames onto the same target race on Windows).
const fileQueues = new Map<string, Promise<void>>();
export async function atomicWrite(file: string, data: string | Uint8Array, signal?: AbortSignal): Promise<void> {
	const key = path.resolve(file).toLowerCase();
	const previous = fileQueues.get(key) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(async () => {
		signal?.throwIfAborted();
		await fs.mkdir(path.dirname(file), { recursive: true });
		const temp = `${file}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temp, data, { signal });
			await renameWithRetry(temp, file, signal);
		} finally {
			await fs.rm(temp, { force: true });
		}
	});
	fileQueues.set(key, current);
	try {
		await current;
	} finally {
		if (fileQueues.get(key) === current) fileQueues.delete(key);
	}
}

export async function readJson(file: string): Promise<any | null> {
	try {
		return JSON.parse(await retryTransient(() => fs.readFile(file, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export async function statFile(file: string) {
	try {
		const stat = await retryTransient(() => fs.stat(file));
		return stat.isFile() ? stat : null;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function revision(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function mediaRevision(stat: import("node:fs").Stats): string {
	return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export function repairedThumbnailFile(projectId: string, mediaId: string): string {
	return path.join(projectDir(projectId), "media", "_thumbnails", `${safeId(mediaId)}.json`);
}

export async function checkedRepairedThumbnailFile(projectId: string, mediaId: string, create = false) {
	const file = repairedThumbnailFile(projectId, mediaId);
	const dir = path.dirname(file);
	const lstat = (target: string) => fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	let folder = await lstat(dir);
	if (!folder && create) {
		await fs.mkdir(dir).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		folder = await lstat(dir);
	}
	if (!folder?.isDirectory() || folder.isSymbolicLink()) return;
	const entry = await lstat(file);
	if (entry ? entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 : create) return file;
}

async function removeRepairedThumbnail(projectId: string, mediaId: string) {
	try {
		const file = await checkedRepairedThumbnailFile(projectId, mediaId);
		if (file) await fs.rm(file, { force: true });
	} catch (error) {
		console.warn("Could not remove repaired thumbnail", error);
	}
}

// One queue per project keeps revision checks and renames ordered.
const locks = new Map<string, Promise<void>>();
export async function withProjectLock<T>(
	id: string,
	action: () => Promise<T>,
): Promise<T> {
	const previous = locks.get(id) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	locks.set(id, current);
	await previous;
	try {
		return await action();
	} finally {
		release();
		if (locks.get(id) === current) locks.delete(id);
	}
}

export async function saveMedia(
	id: string,
	mediaId: string,
	metadata: any,
	body: ReadableStream<Uint8Array>,
): Promise<string | undefined> {
	const dir = path.join(projectDir(id), "media");
	safeId(mediaId);
	if (
		metadata.id !== mediaId ||
		typeof metadata.fileName !== "string" ||
		typeof metadata.fileType !== "string"
	)
		throw new Error("Invalid metadata");
	await fs.mkdir(dir, { recursive: true });
	const ext = path.extname(metadata.fileName).toLowerCase();
	const suffix = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ".bin";
	const fileName = `${mediaId}${suffix}`;
	const file = path.join(dir, fileName);
	const metaFile = path.join(dir, "_metadata", `${mediaId}.json`);
	const old = await readJson(metaFile);
	if (old) {
		const diskFile = old.diskFile;
		if (typeof diskFile === "string" && new RegExp(`^${mediaId}\\.[a-z0-9]{1,10}$`).test(diskFile)) {
			if (await statFile(path.join(dir, diskFile))) return;
		}
		// A repeat upload can repair missing bytes without replacing the saved metadata.
		if (diskFile !== fileName || (old.fileType && old.fileType !== metadata.fileType))
			throw new Error("Upload does not match the saved media");
	}
	const temp = path.join(dir, `${mediaId}.${randomUUID()}.tmp`);
	try {
		await pipeline(
			Readable.fromWeb(
				body as unknown as import("node:stream/web").ReadableStream,
			),
			createWriteStream(temp, { flags: "wx" }),
		);
		await renameWithRetry(temp, file);
		if (!old) {
			try {
				await atomicWrite(
					metaFile,
					JSON.stringify({ ...metadata, diskFile: fileName }),
				);
			} catch (error) {
				// Without metadata the file is unreachable: do not leave it behind.
				await fs.rm(file, { force: true });
				throw error;
			}
		}
		await removeRepairedThumbnail(id, mediaId);
		const stat = await statFile(file);
		return stat ? mediaRevision(stat) : undefined;
	} finally {
		await fs.rm(temp, { force: true });
	}
}

/**
 * Cache the fields needed by range requests without retaining embedded thumbnails or spoken words.
 */
type MediaLocation = { diskFile: string; fileType: string | undefined };
const metadataCache = new Map<string, { mtimeMs: number; size: number; meta: MediaLocation | null }>();
async function readMetadataCached(file: string): Promise<MediaLocation | null> {
	let stat: { mtimeMs: number; size: number };
	try {
		stat = await fs.stat(file);
	} catch {
		metadataCache.delete(file);
		return null;
	}
	const cached = metadataCache.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.meta;
	const stored = await readJson(file);
	const meta = typeof stored?.diskFile === "string"
		? { diskFile: stored.diskFile, fileType: typeof stored.fileType === "string" ? stored.fileType : undefined }
		: null;
	metadataCache.delete(file);
	metadataCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
	if (metadataCache.size > 256) metadataCache.delete(metadataCache.keys().next().value as string);
	return meta;
}

export async function mediaResponse(
	id: string,
	mediaId: string,
	range: string | null,
): Promise<Response> {
	const dir = path.join(projectDir(id), "media");
	const meta = await readMetadataCached(
		path.join(dir, "_metadata", `${safeId(mediaId)}.json`),
	);
	if (!meta || !new RegExp(`^${mediaId}\\.[a-z0-9]{1,10}$`).test(meta.diskFile))
		return new Response(null, { status: 404 });
	const file = path.join(dir, meta.diskFile);
	return streamMediaFile(file, meta.fileType, range);
}

export async function streamMediaFile(file: string, fileType: string | undefined, range: string | null): Promise<Response> {
	// Opened (with retries on transient Windows locks) before the response starts, then streamed from
	// that handle: a lock can no longer turn into a failed body read halfway through a response.
	const handle = await retryTransient(() => fs.open(file, "r")).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	});
	if (!handle) return new Response(null, { status: 404 });
	let streaming = false;
	try {
		const stat = await handle.stat();
		let start = 0,
			end = stat.size - 1,
			status = 200;
		const headers: Record<string, string> = {
			"Accept-Ranges": "bytes",
			"Content-Type": fileType || "application/octet-stream",
			"Cache-Control": "no-store",
			"X-Media-Revision": mediaRevision(stat),
		};
		if (range) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (!match || (!match[1] && !match[2]) || !stat.size)
				return new Response(null, {
					status: 416,
					headers: { "Content-Range": `bytes */${stat.size}` },
				});
			if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
			else {
				start = Number(match[1]);
				if (match[2]) end = Math.min(end, Number(match[2]));
			}
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start > end ||
				start >= stat.size
			)
				return new Response(null, {
					status: 416,
					headers: { "Content-Range": `bytes */${stat.size}` },
				});
			status = 206;
			headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
		}
		headers["Content-Length"] = String(stat.size ? end - start + 1 : 0);
		if (!stat.size) return new Response(null, { status, headers });
		const body = Readable.toWeb(
			handle.createReadStream({ start, end, autoClose: true }),
		) as unknown as ReadableStream;
		streaming = true;
		return new Response(body, { status, headers });
	} finally {
		if (!streaming) await handle.close().catch(() => {});
	}
}

/**
 * Deletes a media file and its metadata. Also removes a file whose metadata write failed
 * (`<mediaId>.<ext>` without metadata), so a failed import leaves nothing behind.
 */
export async function removeMedia(id: string, mediaId: string): Promise<void> {
	const dir = path.join(projectDir(id), "media");
	safeId(mediaId);
	const metaFile = path.join(dir, "_metadata", `${mediaId}.json`);
	const meta = await readJson(metaFile).catch((error) => {
		if (error instanceof SyntaxError) return null;
		throw error;
	});
	const own = new RegExp(`^${mediaId}\\.[a-z0-9]{1,10}$`);
	const files = meta && own.test(meta.diskFile)
		? [meta.diskFile as string]
		: (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => own.test(name));
	for (const name of files) await retryTransient(() => fs.rm(path.join(dir, name), { force: true }));
	await retryTransient(() => fs.rm(metaFile, { force: true }));
	await removeRepairedThumbnail(id, mediaId);
}
