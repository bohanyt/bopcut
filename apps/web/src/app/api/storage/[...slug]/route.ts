import { promises as fs } from "node:fs";
import path from "node:path";
import { agentJobs, getJob, JobError, recoverAgentJobs, rememberDraft } from "@/agent/cli-job-server";
import { JOB_HEADER, type AgentJob } from "@/agent/cli-jobs";
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
	const s = (await params).slug;
	try {
		await recoverAgentJobs();
		const owner = req.headers.get(JOB_HEADER);
		if (owner) {
			const job = getJob(owner);
			if (!job.hidden || job.owner !== owner || s[0] !== "projects" || s[1] !== job.projectId) {
				throw new JobError("The worker can only access its assigned project.", 403);
			}
			if (req.method === "GET" || req.method === "HEAD") return await storage(req, s, job);
			const draftWrite = (req.method === "PUT" && (s.length === 2 || (s.length === 3 && s[2] === "navigation"))) ||
				(s.length === 4 && s[2] === "media" && ["PUT", "POST", "DELETE"].includes(req.method));
			if (job.command !== "draft" || req.headers.has("x-migration") || !draftWrite) {
				throw new JobError("Open the editor once to finish preparing this project, then retry.", 409);
			}
			return await job.use(() => storage(req, s, job));
		}
		return await storage(req, s);
	} catch (error) {
		if (error instanceof JobError) return Response.json({ error: error.message }, { status: error.status });
		console.error("Storage:", error);
		return Response.json({ error: String(error) }, { status: 400 });
	}
}

async function storage(req: Request, s: string[], job?: AgentJob): Promise<Response> {
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
			if (!job) agentJobs.checkRecovery(id);
			if (s.length === 2 && method === "GET") {
				if (!job) await agentJobs.beforeOpen(id);
				const project = await readProject(id);
				return project
					? Response.json(project.value, { headers: { ETag: project.etag } })
					: new Response(null, { status: 404 });
			}
			if (s.length === 2 && method === "PUT")
				return await withProjectLock(id, async () => {
					const value = await req.json();
					job?.signal.throwIfAborted();
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
					if (!migrating && expected !== (current ? revision(current) : "new"))
						return Response.json({ error: "Project changed" }, { status: 409 });
					job?.signal.throwIfAborted();
					const etag = await writeProject(id, value, current, job?.id);
					if (job) job.committed = true;
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
				return Response.json(
					(
						await Promise.all(
							(await names(dir))
								.filter((n) => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(n))
								.map((n) =>
									readJson(path.join(dir, n)).catch((error) => {
										console.error(`Unreadable media metadata ${n}:`, error);
										return null;
									}),
								),
						)
					).filter(
						(meta) =>
							meta &&
							typeof meta.name === "string" &&
							typeof meta.type === "string",
					),
				);
			}
			if (s[2] === "media" && s.length === 3 && method === "DELETE")
				return await withProjectLock(id, async () => {
					await fs.rm(path.join(projectDir(id), "media"), {
						recursive: true,
						force: true,
					});
					return Response.json({ ok: true });
				});
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
						job?.signal.throwIfAborted();
						if (job) {
							if (metadata.staged !== true) throw new JobError("Open the editor to migrate this project's media, then retry.", 409);
							job.staged.add(mediaId);
							await rememberDraft(job);
						}
						await saveMedia(id, mediaId, metadata, req.body, job?.signal);
						return Response.json({ ok: true });
					});
				if (method === "POST")
					return await withProjectLock(id, async () => {
						const dir = path.join(projectDir(id), "media", "_metadata");
						const file = path.join(dir, `${mediaId}.json`);
						const old = await readJson(file);
						const metadata = await req.json();
						if (!old || metadata.id !== mediaId)
							return new Response(null, { status: 400 });
						job?.signal.throwIfAborted();
						if (job && !job.committed && !job.staged.has(mediaId) && !job.words.has(mediaId)) {
							job.words.set(mediaId, old.words);
							await rememberDraft(job);
						}
						await atomicWrite(
							file,
							JSON.stringify({ ...metadata, diskFile: old.diskFile }),
						);
						return Response.json({ ok: true });
					});
				if (method === "DELETE")
					return await withProjectLock(id, async () => {
						await removeMedia(id, mediaId);
						return Response.json({ ok: true });
					});
			}
		}
		return new Response(null, { status: 404 });
}
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;

export const POST = handle;
export const HEAD = handle;
