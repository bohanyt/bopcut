import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite, projectDir, readJson, retryTransient, statFile, withIdleProjectLock } from "./files";

const inlinePattern = /^data:(image\/(?:jpeg|png|webp|gif|avif|svg\+xml))(;base64)?,/i;
const referencePattern = /^\/api\/storage\/projects\/([\w-]{1,128})\/media\/([\w-]{1,128})\/thumbnail\/([a-f0-9]{64})$/;
const thumbnailFile = (projectId: string, key: string) =>
	path.join(projectDir(projectId), "media", "_thumbnails", key);
const metadataFile = (projectId: string, mediaId: string) =>
	path.join(projectDir(projectId), "media", "_metadata", `${mediaId}.json`);
const keyFor = (dataUrl: string) => createHash("sha256").update(dataUrl).digest("hex");
const urlFor = (projectId: string, mediaId: string, key: string) =>
	`/api/storage/projects/${projectId}/media/${mediaId}/thumbnail/${key}`;

export function mediaThumbnailReference(projectId: string, mediaId: string, url: unknown) {
	if (typeof url !== "string") return undefined;
	return inlinePattern.test(url) ? urlFor(projectId, mediaId, keyFor(url)) : url;
}

async function readThumbnailFile(projectId: string, key: string): Promise<string | null> {
	const file = thumbnailFile(projectId, key);
	return retryTransient(() => fs.readFile(file, "utf8")).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	});
}

async function readLegacyThumbnail(projectId: string, mediaId: string, key: string): Promise<string | null> {
	const metadata = await readJson(metadataFile(projectId, mediaId));
	const url = metadata?.thumbnailUrl;
	return typeof url === "string" && inlinePattern.test(url) && keyFor(url) === key ? url : null;
}

/** Called under the destination project lock. The original metadata stays intact until the sidecar commits. */
export async function storeMediaThumbnail(projectId: string, mediaId: string, url: unknown) {
	if (typeof url !== "string" || !url) return undefined;
	const reference = referencePattern.exec(url);
	if (!reference) {
		if (!inlinePattern.test(url)) return url;
		const key = keyFor(url);
		const file = thumbnailFile(projectId, key);
		if (!await statFile(file)) await atomicWrite(file, url);
		return urlFor(projectId, mediaId, key);
	}
	const [, sourceProjectId, sourceMediaId, key] = reference;
	if (!await statFile(thumbnailFile(projectId, key))) {
		// A duplicate may reference a thumbnail still embedded in its source project's metadata.
		const data = await readThumbnailFile(sourceProjectId, key)
			?? await readLegacyThumbnail(sourceProjectId, sourceMediaId, key)
			?? await readThumbnailFile(sourceProjectId, key);
		if (!data) throw new Error("Stored media thumbnail is unavailable");
		await atomicWrite(thumbnailFile(projectId, key), data);
	}
	return urlFor(projectId, mediaId, key);
}

// Thumbnail references can outlive media metadata in the in-memory Undo history. Keep the small
// content-addressed files with the project so Undo can restore them even after the file is deleted.
export async function preserveMediaThumbnail(projectId: string, mediaId: string) {
	const metadata = await readJson(metadataFile(projectId, mediaId));
	const url = metadata?.thumbnailUrl;
	if (typeof url === "string" && inlinePattern.test(url)) await storeMediaThumbnail(projectId, mediaId, url);
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

export async function readMediaThumbnail(projectId: string, mediaId: string, key: string, ifNoneMatch: string | null) {
	if (!/^[a-f0-9]{64}$/.test(key)) return new Response(null, { status: 404 });
	const file = thumbnailFile(projectId, key);
	const exists = await statFile(file);
	const etag = `"${key}"`;
	const cacheKey = `${file}:${mediaId}`;
	let thumbnail = exists ? cache.get(cacheKey) : undefined;
	if (!thumbnail) {
		const legacy = await readLegacyThumbnail(projectId, mediaId, key);
		const data = legacy ?? await readThumbnailFile(projectId, key);
		const header = data && inlinePattern.exec(data);
		if (!data || !header) return new Response(null, { status: 404 });
		const payload = data.slice(header[0].length);
		thumbnail = {
			type: header[1],
			bytes: header[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload)),
		};
		// A thumbnail GET can always serve the legacy bytes while an upload or save holds the
		// project lock. Only attempt its optional migration if it can start immediately.
		if (!legacy || await migrateLegacyThumbnail(projectId, mediaId, key)) cache.set(cacheKey, thumbnail);
	}
	if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
	return new Response(thumbnail.bytes, {
		headers: {
			"Content-Type": thumbnail.type,
			"Content-Security-Policy": "sandbox; default-src 'none'",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, no-cache",
			ETag: etag,
		},
	});
}

function migrateLegacyThumbnail(projectId: string, mediaId: string, key: string) {
	return withIdleProjectLock(projectId, async () => {
		const file = metadataFile(projectId, mediaId);
		const metadata = await readJson(file);
		const url = metadata?.thumbnailUrl;
		if (typeof url !== "string" || !inlinePattern.test(url) || keyFor(url) !== key) return true;
		const thumbnailUrl = await storeMediaThumbnail(projectId, mediaId, url);
		await atomicWrite(file, JSON.stringify({ ...metadata, thumbnailUrl }));
		return true;
	})?.catch((error) => {
		console.error(`Could not migrate media thumbnail (${mediaId}):`, error);
		return false;
	});
}
