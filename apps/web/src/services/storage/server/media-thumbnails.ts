import { createHash } from "node:crypto";
import path from "node:path";
import { projectDir, readJson, statFile } from "./files";

const inlinePattern = /^data:(image\/[a-z0-9][a-z0-9.+-]{0,63})(?:;[a-z0-9-]+=[^;,]*)*(;base64)?,/i;
const metadataFile = (projectId: string, mediaId: string) =>
	path.join(projectDir(projectId), "media", "_metadata", `${mediaId}.json`);
const keyFor = (dataUrl: string) => createHash("sha256").update(dataUrl).digest("hex");
const urlFor = (projectId: string, mediaId: string, key: string) =>
	`/api/storage/projects/${projectId}/media/${mediaId}/thumbnail/${key}`;

export function mediaThumbnailReference(projectId: string, mediaId: string, url: unknown) {
	if (typeof url !== "string") return undefined;
	if (inlinePattern.test(url)) return urlFor(projectId, mediaId, keyFor(url));
	return /^data:/i.test(url) ? undefined : url;
}

type Thumbnail = { type: string; bytes: Uint8Array<ArrayBuffer> };

export class MediaThumbnailCache {
	private entries = new Map<string, Thumbnail>();
	private bytes = 0;

	constructor(private limitBytes = 4 * 1024 * 1024, private limitEntries = 64) {}

	get(key: string) {
		const entry = this.entries.get(key);
		if (entry) {
			this.entries.delete(key);
			this.entries.set(key, entry);
		}
		return entry;
	}

	set(key: string, entry: Thumbnail) {
		const previous = this.entries.get(key);
		if (previous) {
			this.entries.delete(key);
			this.bytes -= previous.bytes.byteLength;
		}
		if (entry.bytes.byteLength > this.limitBytes) return;
		this.entries.set(key, entry);
		this.bytes += entry.bytes.byteLength;
		for (const [oldKey, oldEntry] of this.entries) {
			if (this.entries.size <= this.limitEntries && this.bytes <= this.limitBytes) break;
			this.entries.delete(oldKey);
			this.bytes -= oldEntry.bytes.byteLength;
		}
	}
}

const cache = new MediaThumbnailCache();

export async function readMediaThumbnail(projectId: string, mediaId: string, key: string | undefined, ifNoneMatch: string | null, inline = false) {
	if (key === undefined ? !inline : !/^[a-f0-9]{64}$/.test(key)) return new Response(null, { status: 404 });
	try {
		const file = metadataFile(projectId, mediaId);
		const stat = await statFile(file);
		if (!stat) return new Response(null, { status: 404 });
		const cacheKey = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${key}`;
		let thumbnail = inline ? undefined : cache.get(cacheKey);
		if (!thumbnail) {
			const data: unknown = (await readJson(file))?.thumbnailUrl;
			const header = typeof data === "string" ? inlinePattern.exec(data) : null;
			if (typeof data !== "string" || !header || (key !== undefined && keyFor(data) !== key)) return new Response(null, { status: 404 });
			const bytes = decodeDataPayload(data.slice(header[0].length), !!header[2]);
			if (!bytes?.byteLength) return new Response(null, { status: 404 });
			// Undo and duplication need the exact data URL to keep its content version stable.
			if (inline) return new Response(data, {
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "no-store",
					Vary: "Accept",
				},
			});
			thumbnail = { type: header[1], bytes };
			cache.set(cacheKey, thumbnail);
		}
		const etag = `"${key}"`;
		const headers = {
			"Content-Type": thumbnail.type,
			"Content-Security-Policy": "sandbox; default-src 'none'",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-cache",
			ETag: etag,
			Vary: "Accept",
		};
		return ifNoneMatch === etag
			? new Response(null, { status: 304, headers })
			: new Response(thumbnail.bytes, { headers });
	} catch {
		return new Response(null, { status: 404 });
	}
}

export function isEmbeddedMediaThumbnail(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const header = inlinePattern.exec(value);
	return !!header && !!decodeDataPayload(value.slice(header[0].length), !!header[2])?.byteLength;
}

function decodeDataPayload(payload: string, base64: boolean): Buffer<ArrayBuffer> | null {
	if (/%(?![a-f\d]{2})/i.test(payload)) return null;
	// decodeURIComponent rejects bytes such as %FF. Preserve each escaped octet directly.
	const bytes = payload.includes("%")
		? Buffer.concat(payload.split(/(%[a-f\d]{2})/i).map((part, i) =>
			i % 2 ? Buffer.from(part.slice(1), "hex") : Buffer.from(part)))
		: Buffer.from(payload);
	if (!base64) return bytes;
	const encoded = bytes.toString("latin1").replace(/[\t\n\f\r ]/g, "");
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) return null;
	if (encoded.endsWith("=") && encoded.length % 4 !== 0) return null;
	return Buffer.from(encoded, "base64");
}
