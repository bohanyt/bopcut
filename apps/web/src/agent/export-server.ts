// The server side of agent exports: the result file and saving the video into the workspace's
// exports folder. The result file is the one record of each request (rev): progress, then one final
// answer that nothing replaces, written by whichever editor tab took the request.
import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { atomicWrite, renameWithRetry } from "@/services/storage/server/files";
import { safeName } from "./export";

/** The largest export saved (8 GiB). */
export const MAX_EXPORT_BYTES = 8 * 1024 ** 3;
/** A tab that took a request and has not reported for this long is taken to be gone (closed, crashed). */
export const CLAIM_MS = 60_000;

const RESULT_FILE = "export-result.json";
const REV = /^[a-zA-Z0-9_-]{1,100}$/;
const STATUSES = new Set(["exporting", "done", "error", "release"]);
/** The fields of a final answer the editor sends along with the video. */
const DONE_FIELDS = ["format", "quality", "width", "height", "fps", "duration", "seconds"] as const;

/** Errors of `fs.link` on file systems without hard links (FAT, exFAT, some network drives). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EINVAL", "EMLINK"]);

class TooLarge extends Error {}

type Result = Record<string, unknown> & { rev: string; status: string };

// One result write at a time (each reads the current answer first).
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
	const next = queue.then(run, run);
	queue = next.catch(() => {});
	return next;
}

async function readResult(workspace: string): Promise<Result | null> {
	try {
		const value = JSON.parse(await fs.readFile(path.join(workspace, RESULT_FILE), "utf8"));
		return value && typeof value === "object" && typeof value.rev === "string" ? value : null;
	} catch {
		return null;
	}
}

const isFinal = (result: Result | null, rev: string) => result?.rev === rev && (result.status === "done" || result.status === "error");

/**
 * Writes an answer to the result file, unless the request already has its final answer ("answered") or
 * another tab is exporting it ("claimed"; an "exporting" answer from a tab is its claim).
 */
export function writeExportResult({ workspace, result, now = Date.now() }: { workspace: string; result: Result; now?: number }): Promise<{ ok: true } | { ok: false; reason: "answered" | "claimed" }> {
	return oneAtATime(async () => {
		const current = await readResult(workspace);
		if (isFinal(current, result.rev)) return { ok: false, reason: "answered" } as const;
		if (result.status === "release") {
			if (current?.rev !== result.rev || current.status !== "exporting" ||
				current.tab !== result.tab || current.projectId !== result.projectId) {
				return { ok: false, reason: "claimed" } as const;
			}
			await fs.rm(path.join(workspace, RESULT_FILE), { force: true });
			return { ok: true } as const;
		}
		if (
			result.status === "exporting" && current?.rev === result.rev && current.status === "exporting" && current.tab !== result.tab &&
			now - Date.parse(String(current.updatedAt)) < CLAIM_MS
		) {
			return { ok: false, reason: "claimed" } as const;
		}
		await atomicWrite(path.join(workspace, RESULT_FILE), JSON.stringify({ ...result, updatedAt: new Date(now).toISOString() }, null, 1));
		return { ok: true } as const;
	});
}

const refused = (reason: "answered" | "claimed") =>
	Response.json({ error: reason === "answered" ? "This request already has its answer" : "Another editor tab is exporting this request", [reason]: true }, { status: 409 });

/** POST export-result: progress or an error from the editor (see writeExportResult). */
export async function handleExportResult(req: Request, workspace: string): Promise<Response> {
	const text = await readTextLimited(req, 1024 * 1024);
	if (text === null) return Response.json({ error: "Result too large" }, { status: 413 });
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return Response.json({ error: "Invalid result" }, { status: 400 });
	}
	const result = body as Result;
	if (!result || typeof result !== "object" || typeof result.rev !== "string" || !REV.test(result.rev) || !STATUSES.has(result.status) || result.status === "done") {
		// "done" is written with the video (POST export-file), never on its own.
		return Response.json({ error: "Invalid result" }, { status: 400 });
	}
	if (result.status === "release" && (typeof result.tab !== "string" || !result.tab || typeof result.projectId !== "string" || !result.projectId)) {
		return Response.json({ error: "Invalid claim release" }, { status: 400 });
	}
	const written = await writeExportResult({ workspace, result });
	return written.ok ? Response.json({ ok: true }) : refused(written.reason);
}

/** POST export-file: saves the video, then writes the final answer with it (one request, so neither is lost). */
export async function handleExportFile(req: Request, workspace: string, job?: {
	signal: AbortSignal; temp: string; finish(result: Result): Promise<void>;
}): Promise<Response> {
	const query = new URL(req.url).searchParams;
	const rev = query.get("rev") ?? "";
	let done: Record<string, unknown> = {};
	try {
		done = JSON.parse(query.get("result") ?? "{}");
	} catch {
		// checked below
	}
	if (!REV.test(rev) || !req.body || !done || typeof done !== "object" || (query.get("result") ?? "").length > 4096) return Response.json({ error: "Invalid export" }, { status: 400 });
	if (Number(req.headers.get("content-length") ?? 0) > MAX_EXPORT_BYTES) return Response.json({ error: "Export too large" }, { status: 413 });
	// Not saved again once the request has its answer (for example from another tab).
	if (isFinal(await readResult(workspace), rev)) return refused("answered");
	const saved = await saveExport({ dir: path.join(workspace, "exports"), name: query.get("name") ?? "", format: query.get("format") ?? "", body: req.body, temp: job?.temp, signal: job?.signal });
	if ("error" in saved) return Response.json({ error: saved.error }, { status: saved.status });
	const file = `exports/${saved.file}`;
	const fields = Object.fromEntries(DONE_FIELDS.filter((key) => key in done).map((key) => [key, done[key]]));
	const result: Result = { rev, projectId: query.get("projectId") ?? undefined, tab: query.get("tab") ?? undefined, status: "done", file, bytes: saved.bytes, ...fields };
	if (job) await job.finish({ ...result, updatedAt: new Date().toISOString() });
	else await writeExportResult({ workspace, result });
	return Response.json({ file, bytes: saved.bytes });
}

export type SavedExport = { file: string; bytes: number } | { error: string; status: number };

/**
 * Streams `body` into `<dir>/<name>.<format>`; if that name is taken, `<name> (2).<format>` and so on (an
 * earlier export is never overwritten, also when two saves of one name run at once). Refuses a body over
 * `maxBytes` and an exports folder that is a link (it could point anywhere).
 */
export async function saveExport({ dir, name, format, body, maxBytes = MAX_EXPORT_BYTES, temp = path.join(dir, `.${randomUUID()}.part`), signal }: {
	dir: string; name: string; format: string; body: ReadableStream<Uint8Array>; maxBytes?: number; temp?: string; signal?: AbortSignal;
}): Promise<SavedExport> {
	const safe = safeName(name);
	if ((format !== "mp4" && format !== "webm") || !safe) return { error: "Invalid export", status: 400 };
	await fs.mkdir(dir, { recursive: true });
	const folder = await fs.lstat(dir);
	if (folder.isSymbolicLink() || !folder.isDirectory()) return { error: "The exports folder must be a folder, not a link", status: 403 };
	// Each save writes its own new file first; it gets its name only when it is complete.
	let bytes = 0;
	const count = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			bytes += chunk.length;
			done(bytes > maxBytes ? new TooLarge() : null, chunk);
		},
	});
	try {
		try {
			await pipeline(Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream), count, createWriteStream(temp, { flags: "wx" }), { signal });
		} catch (error) {
			if (error instanceof TooLarge) return { error: `Export larger than ${maxBytes} bytes`, status: 413 };
			throw error;
		}
		let hardLinks = true;
		for (let n = 1; n <= 999; ) {
			signal?.throwIfAborted();
			const file = `${safe}${n > 1 ? ` (${n})` : ""}.${format}`;
			const target = path.join(dir, file);
			try {
				if (hardLinks) {
					// Linked under the name only if it is free.
					await fs.link(temp, target);
				} else {
					// Without hard links: the name is taken (created only if free), then the file moved onto it
					// (retried while something such as a virus scanner briefly holds it).
					await (await fs.open(target, "wx")).close();
					try {
						await renameWithRetry(temp, target);
					} catch (error) {
						await fs.rm(target, { force: true });
						throw error;
					}
				}
				return { file, bytes };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "";
				if (code === "EEXIST") n++;
				else if (hardLinks && NO_HARD_LINKS.has(code)) hardLinks = false;
				else throw error;
			}
		}
		return { error: "Too many exports with this name", status: 400 };
	} finally {
		await fs.rm(temp, { force: true });
	}
}

/** A request's text, or null when it has more than `max` bytes (checked while it is read, not after). */
export async function readTextLimited(req: Request, max: number): Promise<string | null> {
	if (Number(req.headers.get("content-length") ?? 0) > max) return null;
	if (!req.body) return "";
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}
