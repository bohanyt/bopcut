// Saving an exported video into the workspace's exports folder (server side).
import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safeName } from "./export";

/** The largest export saved (8 GiB). */
export const MAX_EXPORT_BYTES = 8 * 1024 ** 3;

/** Errors of `fs.link` on file systems without hard links (FAT, exFAT, some network drives). */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EINVAL", "EMLINK"]);

class TooLarge extends Error {}

export type SavedExport = { file: string } | { error: string; status: number };

/**
 * Streams `body` into `<dir>/<name>.<format>`; if that name is taken, `<name> (2).<format>` and so on (an
 * earlier export is never overwritten, also when two saves of one name run at once). Refuses a body over
 * `maxBytes` and an exports folder that is a link (it could point anywhere).
 */
export async function saveExport({ dir, name, format, body, maxBytes = MAX_EXPORT_BYTES }: { dir: string; name: string; format: string; body: ReadableStream<Uint8Array>; maxBytes?: number }): Promise<SavedExport> {
	const safe = safeName(name);
	if ((format !== "mp4" && format !== "webm") || !safe) return { error: "Invalid export", status: 400 };
	await fs.mkdir(dir, { recursive: true });
	const folder = await fs.lstat(dir);
	if (folder.isSymbolicLink() || !folder.isDirectory()) return { error: "The exports folder must be a folder, not a link", status: 409 };
	// Each save writes its own new file first; it gets its name only when it is complete.
	const temp = path.join(dir, `.${randomUUID()}.part`);
	let bytes = 0;
	const count = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			bytes += chunk.length;
			done(bytes > maxBytes ? new TooLarge() : null, chunk);
		},
	});
	try {
		try {
			await pipeline(Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream), count, createWriteStream(temp, { flags: "wx" }));
		} catch (error) {
			if (error instanceof TooLarge) return { error: `Export larger than ${maxBytes} bytes`, status: 413 };
			throw error;
		}
		let hardLinks = true;
		for (let n = 1; n <= 999; ) {
			const file = `${safe}${n > 1 ? ` (${n})` : ""}.${format}`;
			const target = path.join(dir, file);
			try {
				if (hardLinks) {
					// Linked under the name only if it is free.
					await fs.link(temp, target);
				} else {
					// Without hard links: the name is taken (created only if free), then the file moved onto it.
					await (await fs.open(target, "wx")).close();
					try {
						await fs.rename(temp, target);
					} catch (error) {
						await fs.rm(target, { force: true });
						throw error;
					}
				}
				return { file };
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "";
				if (code === "EEXIST") n++;
				else if (hardLinks && NO_HARD_LINKS.has(code)) hardLinks = false;
				else throw error;
			}
		}
		return { error: "Too many exports with this name", status: 409 };
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
