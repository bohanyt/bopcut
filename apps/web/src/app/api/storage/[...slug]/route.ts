import { promises as fs } from "node:fs";
import path from "node:path";
import {
	atomicWrite,
	dataRoot,
	mediaResponse,
	projectDir,
	readJson,
	removeMedia,
	revision,
	safeId,
	saveMedia,
	statFile,
	withProjectLock,
} from "@/services/storage/server/files";
import {
	projectFile,
	readProject,
	readProjectSummary,
	readProjectThumbnail,
	writeProject,
	writeProjectNavigation,
	writeProjectThumbnail,
} from "@/services/storage/server/projects";
import {
	isEmbeddedMediaThumbnail,
	mediaThumbnailReference,
	readMediaThumbnail,
	resolveMediaThumbnailReference,
	storeMissingMediaThumbnail,
} from "@/services/storage/server/media-thumbnails";
import type { MediaAssetData } from "@/services/storage/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function allowed(req: Request): boolean {
	const url = new URL(req.url);
	const origin = req.headers.get("origin");
	return (
		(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
		(!origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))
	);
}
const marker = (id: string) =>
	path.join(dataRoot(), "migrated", `${safeId(id)}.json`);
const mediaEditorFields = {
	id: true, name: true, fileName: true, fileType: true, type: true, size: true, lastModified: true,
	width: true, height: true, duration: true, fps: true, hasVariableGifDelay: true, hasAudio: true,
	ephemeral: true, staged: true, words: true,
} satisfies Record<Exclude<keyof MediaAssetData, "thumbnailUrl">, true>;
async function names(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
async function handle(
	req: Request,
	{ params }: { params: Promise<{ slug: string[] }> },
): Promise<Response> {
	if (!allowed(req))
		return Response.json({ error: "Origin ditolak" }, { status: 403 });
	try {
		const s = (await params).slug;
		const method = req.method;
		if (s[0] === "sounds" && s.length === 1) {
			const file = path.join(dataRoot(), "sounds.json");
			if (method === "GET") return Response.json(await readJson(file));
			if (method === "PUT")
				return await withProjectLock("__sounds", async () => {
					const markerFile = path.join(dataRoot(), "sounds-migrated.json");
					const migrating = req.headers.get("if-none-match") === "*";
					if (
						migrating &&
						((await readJson(file)) || (await readJson(markerFile)))
					)
						return Response.json({ skipped: true });
					await atomicWrite(file, JSON.stringify(await req.json()));
					if (migrating)
						await atomicWrite(markerFile, JSON.stringify({ migrated: true }));
					return Response.json({ skipped: false });
				});
			if (method === "DELETE")
				return await withProjectLock("__sounds", async () => {
					await atomicWrite(
						path.join(dataRoot(), "sounds-migrated.json"),
						JSON.stringify({ deleted: true }),
					);
					await fs.rm(file, { force: true });
					return Response.json({ ok: true });
				});
		}
		if (s[0] === "projects" && s.length === 1 && method === "GET") {
			const summaries = [];
			const ids = (await names(path.join(dataRoot(), "projects")))
				.filter((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id));
			// Bound simultaneous legacy backfills, which each read a full timeline.
			for (let i = 0; i < ids.length; i += 8) {
				const batch = await Promise.all(ids.slice(i, i + 8).map((id) =>
					readProjectSummary(id).catch((error) => {
						console.error(`Unreadable project summary (${id}):`, error);
						return null;
					}),
				));
				for (const summary of batch) if (summary) summaries.push(summary);
			}
			return Response.json(summaries);
		}
		if (s[0] === "projects" && s[1]) {
			const id = safeId(s[1]);
			if (s.length === 2 && method === "GET") {
				const project = await readProject(id);
				return project
					? Response.json(project.value, { headers: { ETag: project.etag } })
					: new Response(null, { status: 404 });
			}
			if (s.length === 2 && method === "PUT")
				return await withProjectLock(id, async () => {
					const value = await req.json();
					if (value?.metadata?.id !== id)
						return Response.json(
							{ error: "Project ID mismatch" },
							{ status: 400 },
						);
					const current = await readJson(projectFile(id));
					const migrating = req.headers.get("x-migration") === "1";
					if (migrating && (current || (await readJson(marker(id)))))
						return Response.json({ skipped: true });
					const expected = req.headers.get("if-match");
					if (!migrating && !current && expected === "new" && (await readJson(marker(id)))?.deleted)
						return new Response(null, { status: 404 });
					if (!migrating && expected !== (current ? revision(current) : "new"))
						return Response.json({ error: "Project changed" }, { status: 409 });
					const etag = await writeProject(id, value, current);
					if (migrating)
						await atomicWrite(marker(id), JSON.stringify({ migrated: true }));
					return Response.json(
						{ skipped: false },
						{ headers: { ETag: etag } },
					);
				});
			if (s.length === 2 && method === "DELETE")
				return await withProjectLock(id, async () => {
					await atomicWrite(marker(id), JSON.stringify({ deleted: true }));
					// Moved out of the projects in one step first: if that fails (a file is held open), nothing of
					// the project is removed, so a failed delete never leaves a timeline without its media.
					const trash = path.join(dataRoot(), "trash", `${id}-${Date.now()}`);
					await fs.mkdir(path.dirname(trash), { recursive: true });
					try {
						await fs.rename(projectDir(id), trash);
					} catch (error) {
						// Already gone is fine.
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					// What cannot be removed now stays in the trash folder (the project is gone either way) and is
					// tried again on the next delete, with anything else left there.
					const left = await fs.readdir(path.dirname(trash)).catch(() => [] as string[]);
					await Promise.all(
						left.map((name) =>
							fs.rm(path.join(path.dirname(trash), name), { recursive: true, force: true }).catch((error) => {
								console.error(`Deleted project files not removed yet (${name}):`, error);
							}),
						),
					);
					return Response.json({ ok: true });
				});
			if (s[2] === "migration" && s.length === 3 && method === "GET")
				return Response.json({
					exists:
						!!(await statFile(projectFile(id))) ||
						!!(await statFile(marker(id))),
				});
			if (s[2] === "navigation" && s.length === 3 && method === "PUT") {
				const navigation = await req.json();
				return await withProjectLock(id, async () =>
					(await statFile(projectFile(id)))
						? writeProjectNavigation(id, navigation)
						: new Response(null, { status: 404 }),
				);
			}
			if (s[2] === "thumbnail" && s.length === 3) {
				if (method === "GET") return await readProjectThumbnail(id, req.headers.get("if-none-match"));
				if (method === "PUT") {
					const bytes = new Uint8Array(await req.arrayBuffer());
					return await withProjectLock(id, async () =>
						(await statFile(projectFile(id)))
							? writeProjectThumbnail(id, bytes)
							: new Response(null, { status: 404 }),
					);
				}
			}
			if (s[2] === "media" && s.length === 3 && method === "GET") {
				const dir = path.join(projectDir(id), "media", "_metadata");
				const files = (await names(dir)).filter((name) => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(name));
				const manifest = [];
				for (let index = 0; index < files.length; index += 32) {
					const batch = await Promise.all(files.slice(index, index + 32).map(async (name) => {
						const metadata = await readJson(path.join(dir, name)).catch((error) => {
							console.error(`Unreadable media metadata ${name}:`, error);
							return null;
						});
						if (typeof metadata?.name !== "string" || typeof metadata.type !== "string") return null;
						metadata.thumbnailUrl = await resolveMediaThumbnailReference(id, name.slice(0, -5), metadata);
						return metadata;
					}));
					for (const metadata of batch) if (metadata) manifest.push(metadata);
				}
				return Response.json(manifest);
			}
			if (s[2] === "media" && s.length === 3 && method === "DELETE")
				return await withProjectLock(id, async () => {
					await fs.rm(path.join(projectDir(id), "media"), {
						recursive: true,
						force: true,
					});
					return Response.json({ ok: true });
				});
			if (s[2] === "media" && s[3] && s[4] === "thumbnail" && method === "GET") {
				const inline = req.headers.get("accept") === "text/plain";
				if (s.length === 6 || (s.length === 5 && inline)) {
					return await readMediaThumbnail(id, safeId(s[3]), s[5], req.headers.get("if-none-match"), inline);
				}
			}
			if (s[2] === "media" && s[3] && s[4] === "thumbnail" && s.length === 5 && method === "POST") {
				return await storeMissingMediaThumbnail(id, safeId(s[3]), req.headers.get("x-media-revision"), await req.text(), req.signal);
			}
			if (s[2] === "media" && s[3] && s.length === 4) {
				const mediaId = safeId(s[3]);
				if (method === "HEAD") {
					const dir = path.join(projectDir(id), "media");
					const metadata = await readJson(path.join(dir, "_metadata", `${mediaId}.json`));
					if (!metadata || metadata.staged || typeof metadata.name !== "string" ||
						typeof metadata.type !== "string" ||
						!new RegExp(`^${mediaId}\\.[a-z0-9]{1,10}$`).test(metadata.diskFile) ||
						!(await statFile(path.join(dir, metadata.diskFile)))) {
						return new Response(null, { status: 404 });
					}
					return new Response(null, { status: 204 });
				}
				if (method === "GET")
					return await mediaResponse(id, mediaId, req.headers.get("range"));
				if (method === "PUT")
					return await withProjectLock(id, async () => {
						// A delayed upload or Undo write must not recreate a deleted project.
						if (!(await statFile(projectFile(id))) && (await readJson(marker(id)))?.deleted)
							return new Response(null, { status: 404 });
						if (!req.body) return new Response(null, { status: 400 });
						const metadata = JSON.parse(
							decodeURIComponent(req.headers.get("x-media-metadata") ?? ""),
						);
						const savedRevision = await saveMedia(id, mediaId, metadata, req.body);
						return Response.json({ ok: true }, {
							headers: savedRevision ? { "X-Media-Revision": savedRevision } : undefined,
						});
					});
				if (method === "POST") {
					const metadata = await req.json();
					if (metadata?.id !== mediaId) return new Response(null, { status: 400 });
					return await withProjectLock(id, async () => {
						const dir = path.join(projectDir(id), "media", "_metadata");
						const file = path.join(dir, `${mediaId}.json`);
						const old = await readJson(file);
						if (!old) return new Response(null, { status: 400 });
						for (const field of Object.keys(mediaEditorFields)) old[field] = metadata[field];
						if (metadata.thumbnailUrl === null) delete old.thumbnailUrl;
						else if (isEmbeddedMediaThumbnail(metadata.thumbnailUrl)) old.thumbnailUrl = metadata.thumbnailUrl;
						await atomicWrite(file, JSON.stringify(old));
						const reference = mediaThumbnailReference(id, mediaId, old.thumbnailUrl);
						return Response.json({ ok: true }, {
							headers: reference && reference !== old.thumbnailUrl
								? { "X-Media-Thumbnail": reference }
								: undefined,
						});
					});
				}
				if (method === "DELETE")
					return await withProjectLock(id, async () => {
						await removeMedia(id, mediaId);
						return Response.json({ ok: true });
					});
			}
		}
		return new Response(null, { status: 404 });
	} catch (error) {
		console.error("Storage:", error);
		return Response.json({ error: String(error) }, { status: 400 });
	}
}
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;

export const POST = handle;
export const HEAD = handle;
