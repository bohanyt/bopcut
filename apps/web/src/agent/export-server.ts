// Saving an exported video into the workspace's exports folder (server side).
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safeName } from "./export";

/**
 * Streams `body` into `<dir>/<name>.<format>`; if that name is taken, `<name> (2).<format>` and so on (an
 * earlier export is never overwritten). Returns the file name; null when the name or format is invalid.
 */
export async function saveExport({ dir, name, format, body }: { dir: string; name: string; format: string; body: ReadableStream<Uint8Array> }): Promise<string | null> {
	const safe = safeName(name);
	if ((format !== "mp4" && format !== "webm") || !safe) return null;
	await fs.mkdir(dir, { recursive: true });
	const temp = path.join(dir, `.${safe}.${process.pid}.${Date.now()}.part`);
	try {
		await pipeline(Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream), createWriteStream(temp));
		for (let n = 1; ; n++) {
			const file = `${safe}${n > 1 ? ` (${n})` : ""}.${format}`;
			try {
				// Linked under the name only if it is free.
				await fs.link(temp, path.join(dir, file));
				return file;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || n > 999) throw error;
			}
		}
	} finally {
		await fs.rm(temp, { force: true });
	}
}
