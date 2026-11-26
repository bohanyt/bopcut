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

type ReceivedMedia = {
	dir: string;
	fileName: string;
	file: string;
	metaFile: string;
	/** The streamed bytes, or null when the file was already stored and the body was not read. */
	temp: string | null;
};

function mediaPaths(id: string, mediaId: string, metadata: any): Omit<ReceivedMedia, "temp"> {
	safeId(mediaId);
	if (
		metadata?.id !== mediaId ||
		typeof metadata.fileName !== "string" ||
		typeof metadata.fileType !== "string"
	)
		throw new Error("Invalid metadata");
	const dir = path.join(projectDir(id), "media");
	const ext = path.extname(metadata.fileName).toLowerCase();
	const suffix = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ".bin";
	const fileName = `${mediaId}${suffix}`;
	return { dir, fileName, file: path.join(dir, fileName), metaFile: path.join(dir, "_metadata", `${mediaId}.json`) };
}

/** True when the media is already stored. Throws when an upload under this ID does not match it. */
async function isMediaStored(paths: Omit<ReceivedMedia, "temp">, mediaId: string, metadata: any, old: any): Promise<boolean> {
	if (!old) return false;
	const diskFile = old.diskFile;
	if (typeof diskFile === "string" && new RegExp(`^${mediaId}\\.[a-z0-9]{1,10}$`).test(diskFile)) {
		if (await statFile(path.join(paths.dir, diskFile))) return true;
	}
	// A repeat upload can repair missing bytes without replacing the saved metadata.
	if (diskFile !== paths.fileName || (old.fileType && old.fileType !== metadata.fileType))
		throw new Error("Upload does not match the saved media");
	return false;
}

/**
 * Streams an upload to a temporary file outside the project folder, without the project lock, so a
 * large or stalled upload does not hold up the project's saves. A file that is already stored is
 * not read again. Pass the result to commitMedia under the lock, then to discardReceivedMedia.
 */
export async function receiveMedia(
	id: string,
	mediaId: string,
	metadata: any,
	body: ReadableStream<Uint8Array>,
): Promise<ReceivedMedia> {
	const paths = mediaPaths(id, mediaId, metadata);
	if (await isMediaStored(paths, mediaId, metadata, await readJson(paths.metaFile))) return { ...paths, temp: null };
	// Same volume as the projects, so the commit is a rename; never inside a project that may be deleted meanwhile.
	const uploads = path.join(dataRoot(), "uploads");
	await fs.mkdir(uploads, { recursive: true });
	const temp = path.join(uploads, `${safeId(id)}.${mediaId}.${randomUUID()}.tmp`);
	try {
		await pipeline(
			Readable.fromWeb(
				body as unknown as import("node:stream/web").ReadableStream,
			),
			createWriteStream(temp, { flags: "wx" }),
		);
	} catch (error) {
		await fs.rm(temp, { force: true });
		throw error;
	}
	return { ...paths, temp };
}

/** Moves a received upload into the project and writes its metadata. Run it under the project lock. */
export async function commitMedia(
	id: string,
	mediaId: string,
	metadata: any,
	received: ReceivedMedia,
): Promise<string | undefined> {
	const { dir, fileName, file, metaFile, temp } = received;
	const old = await readJson(metaFile);
	if (await isMediaStored(received, mediaId, metadata, old)) return;
	// The stored file was removed while this request skipped its body: the client sends it again.
	if (!temp) throw new Error("Upload does not match the saved media");
	await fs.mkdir(path.dirname(metaFile), { recursive: true });
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
	const stat = await statFile(path.join(dir, fileName));
	return stat ? mediaRevision(stat) : undefined;
}

export async function discardReceivedMedia(received: ReceivedMedia): Promise<void> {
	if (received.temp) await fs.rm(received.temp, { force: true });
}

/** Receive and commit in one step, for callers that already hold the project lock or need no lock. */
export async function saveMedia(
	id: string,
	mediaId: string,
	metadata: any,
	body: ReadableStream<Uint8Array>,
): Promise<string | undefined> {
	const received = await receiveMedia(id, mediaId, metadata, body);
	try {
		return await commitMedia(id, mediaId, metadata, received);
	} finally {
		await discardReceivedMedia(received);
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
	signal?: AbortSignal,
): Promise<Response> {
	const dir = path.join(projectDir(id), "media");
	const meta = await readMetadataCached(
		path.join(dir, "_metadata", `${safeId(mediaId)}.json`),
	);
	if (!meta || !new RegExp(`^${mediaId}\\.[a-z0-9]{1,10}$`).test(meta.diskFile))
		return new Response(null, { status: 404 });
	const file = path.join(dir, meta.diskFile);
	return streamMediaFile(file, meta.fileType, range, signal);
}

const mediaChunkBytes = 512 * 1024;

function mediaBody(handle: Awaited<ReturnType<typeof fs.open>>, start: number, end: number, signal?: AbortSignal) {
	let position = start;
	let closing: Promise<void> | undefined;
	let abort: (() => void) | undefined;
	const close = () => {
		if (abort) signal?.removeEventListener("abort", abort);
		return closing ??= handle.close();
	};

	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (!signal) return;
			abort = () => {
				controller.error(signal.reason);
				void close().catch(() => {});
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		},
		async pull(controller) {
			try {
				const length = Math.min(mediaChunkBytes, end - position + 1);
				const { bytesRead, buffer } = await handle.read(new Uint8Array(length), 0, length, position);
				if (closing) return;
				if (!bytesRead) throw new Error("Media file ended before its advertised length");
				position += bytesRead;
				controller.enqueue(buffer.subarray(0, bytesRead));
				if (position > end) {
					controller.close();
					await close();
				}
			} catch (error) {
				if (closing) return;
				controller.error(error);
				await close().catch(() => {});
			}
		},
		cancel: close,
	}, { highWaterMark: 1 });
}

export async function streamMediaFile(file: string, fileType: string | undefined, range: string | null, signal?: AbortSignal): Promise<Response> {
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
		const body = mediaBody(handle, start, end, signal);
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
