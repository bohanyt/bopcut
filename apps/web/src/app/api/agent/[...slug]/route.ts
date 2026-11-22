// Local OpenCut <-> agent bridge (AI/scripts). For local development only (127.0.0.1).
//
// AGENT_WORKSPACE   agent workspace: bundle/bundle.json, sync/<projectId>.json,
//                   project.json (last synced project), draft.json, draft-result.json
// AGENT_FILES_ROOT  bundle asset root (default = AGENT_WORKSPACE). Files outside this root are not served.
import { promises as fs } from "node:fs";
import path from "node:path";
import { jobRunner } from "@/retrieval/job-runner";
import { handleRetrieve } from "@/retrieval/server";
import { handleGif } from "@/media/gif-server";
import { handleSfx, libraryPreviewFile } from "@/sounds/sfx-server";
import { MUSIC_LIBRARY, handleMusic } from "@/sounds/music-server";
import { handleDuck } from "@/sounds/duck-server";
import { parseSelectionPayload } from "@/agent/selection-payload";
import { consumeAppliedDraft } from "@/agent/draft-store";
import { isForeignOrigin } from "@/agent/origin";
import { atomicWrite } from "@/services/storage/server/files";
import { handleExportFile, handleExportResult } from "@/agent/export-server";
import { handleCli, offerVisibleJob, requestKey } from "@/agent/cli-api";
import { finishJob, getJob, JobError, writeWorkspaceSnapshot } from "@/agent/cli-job-server";
import { JOB_HEADER, type AgentJob } from "@/agent/cli-jobs";

const WORKSPACE = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(process.cwd(), "..", "..", "workspace"));
const FILES_ROOT = path.resolve(process.env.AGENT_FILES_ROOT ?? WORKSPACE);
const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".json": "application/json" };
const json = (data: Buffer | string) => new Response(typeof data === "string" ? data : new Uint8Array(data), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function inside(rel: string) {
	const full = path.resolve(FILES_ROOT, rel);
	if (!full.startsWith(FILES_ROOT + path.sep)) throw new Error("Path outside AGENT_FILES_ROOT");
	return full;
}

// Unique temp file, rename retried on transient Windows locks, writes to one file queued.
const writeAtomic = atomicWrite;

/**
 * Browser requests must come from the editor's own origin (same host and port). A page on another site,
 * or on another local port, cannot trigger agent actions. Clients that send no Origin (CLIs) are allowed.
 */
const foreignOrigin = isForeignOrigin;

export async function GET(req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
	const { slug } = await params;
	if (slug[0] === "cli") return handleCli(req, slug, WORKSPACE);
	if (slug[0] === "job") {
		try {
			const job = ownedJob(req, slug[1]);
			return Response.json(slug[2] === requestKey(job.command) ? job.body : null);
		} catch (error) { return jobError(error); }
	}
	try {
		if (slug[0] === "bundle") return json(await fs.readFile(path.join(WORKSPACE, "bundle", "bundle.json")));
		if (slug[0] === "file") {
			const full = inside(new URL(req.url).searchParams.get("p") ?? "");
			return new Response(new Uint8Array(await fs.readFile(full)), { headers: { "Content-Type": TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" } });
		}
		if (slug[0] === "sfx-file" || slug[0] === "music-file") {
			// Preview of a sound or song in one of the library folders (BOPENCUT_SFX_DIRS / BOPENCUT_MUSIC_DIRS may be outside AGENT_FILES_ROOT).
			const ref = new URL(req.url).searchParams.get("ref") ?? "";
			const file = await libraryPreviewFile(ref, { filesRoot: FILES_ROOT }, slug[0] === "music-file" ? MUSIC_LIBRARY : undefined);
			if (!file) return Response.json({ error: "Not found" }, { status: 404 });
			return new Response(new Uint8Array(await fs.readFile(file)), { headers: { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" } });
		}
		if (slug[0] === "frames-request") {
			try { return json(await fs.readFile(path.join(WORKSPACE, "frames-request.json"))); } catch { return Response.json(null); }
		}
		if (slug[0] === "export-request") {
			try { return json(await fs.readFile(path.join(WORKSPACE, "export-request.json"))); } catch { return Response.json(null); }
		}
		if (slug[0] === "changes-request") {
			try { return json(await fs.readFile(path.join(WORKSPACE, "changes-request.json"))); } catch { return Response.json(null); }
		}
		if (slug[0] === "draft") {
			const offer = !foreignOrigin(req) && offerVisibleJob(req);
			if (offer) return Response.json(null, { headers: { "x-bopencut-claim": JSON.stringify(offer), "Cache-Control": "no-store" } });
			if (req.headers.get("x-bopencut-draft-ready") === "false") return Response.json(null);
			try { return json(await fs.readFile(path.join(WORKSPACE, "draft.json"))); } catch { return Response.json(null); }
		}
	} catch (error) {
		return Response.json({ error: String(error) }, { status: 404 });
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
	const { slug } = await params;
	if (foreignOrigin(req)) return Response.json({ error: "Requests must come from the editor itself" }, { status: 403 });
	if (slug[0] === "cli") return handleCli(req, slug, WORKSPACE);
	if (slug[0] === "job") {
		try {
			const job = ownedJob(req, slug[1]);
			return await job.use(() => writeJobResult(req, job, slug[2]));
		} catch (error) { return jobError(error); }
	}
	if (slug[0] === "frame") return saveFrame(req);
	return legacyPost(req, slug);
}

function ownedJob(req: Request, id: string) {
	const job = getJob(id);
	if (!job.owner || req.headers.get(JOB_HEADER) !== job.owner) throw new JobError("The job belongs to another tab.", 403);
	return job;
}

function jobError(error: unknown) {
	return Response.json({ error: error instanceof Error ? error.message : "Agent job failed" }, { status: error instanceof JobError ? error.status : 500 });
}

async function writeJobResult(req: Request, job: AgentJob, action: string) {
	if (job.update.done) return Response.json({ answered: true }, { status: 409 });
	const finish = async (body: Record<string, unknown>) => {
		const editorHint = " Open the project in the editor once and retry.";
		const unsupported = (error: unknown) => typeof error === "string" && /codec|encod|graphics|webgl|webgpu/i.test(error);
		if (job.hidden && unsupported(body.error)) body.error += editorHint;
		if (job.hidden && Array.isArray(body.errors)) {
			for (const frame of body.errors) if (frame && unsupported(frame.error)) frame.error += editorHint;
		}
		await finishJob(job, body);
		return Response.json({ ok: true });
	};
	if (job.command === "draft") {
		const runner = jobRunner(job.signal);
		if (action === "gif") return handleGif(req, runner);
		if (action === "retrieve" || action === "music" || action === "sfx") {
			const handler = action === "retrieve" ? handleRetrieve : action === "music" ? handleMusic : handleSfx;
			const result = await handler(await req.json().catch(() => null), { filesRoot: FILES_ROOT, runner, jobId: job.id });
			return Response.json(result.body, { status: result.status });
		}
	}
	if (job.command === "export") {
		if (action === "export-result") {
			const body = await req.json();
			if (body.status === "exporting") job.progress("encoding", Math.round(body.progress * 100));
			if (body.status === "error") return finish(body);
			return Response.json({ ok: true });
		}
		if (action === "export-file") {
			job.progress("saving");
			return handleExportFile(req, WORKSPACE, { signal: job.signal, finish: (body) => finishJob(job, body) });
		}
	}
	if (job.command === "frames" && action === "frame") return saveFrame(req, job);
	if ((job.command === "draft" && action === "applied") || action === job.command + "-result") return finish(await req.json());
	if (job.hidden && job.command === "draft" && action === "sync" && job.committed) {
		const body = await req.json();
		await writeWorkspaceSnapshot(WORKSPACE, body, true);
		return Response.json({ ok: true });
	}
	return Response.json({ error: "Invalid result for this job" }, { status: 400 });
}

async function saveFrame(req: Request, job?: AgentJob) {
		const form = await req.formData();
		const rev = form.get("rev"); const time = form.get("time"); const image = form.get("image"); const variant = form.get("variant");
		if (typeof rev !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(rev) || typeof time !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(time) || !(image instanceof File) || image.type !== "image/jpeg" || (variant !== null && variant !== "compare")) return Response.json({ error: "Invalid frame" }, { status: 400 });
		// A compared state's frame (before/after pairs) sits next to the frame of the same time.
		const name = variant === "compare" ? `${time}-compare.jpg` : `${time}.jpg`;
		job?.signal.throwIfAborted();
		const folder = job?.id ?? rev;
		const file = `frames/${folder}/${name}`;
		await fs.mkdir(path.join(WORKSPACE, "frames", folder), { recursive: true });
		const target = path.join(WORKSPACE, "frames", folder, name);
		job?.frameFiles.add(target);
		await fs.writeFile(target, Buffer.from(await image.arrayBuffer()), { signal: job?.signal });
		return Response.json({ file });
}

async function legacyPost(req: Request, slug: string[]) {
	if (slug[0] === "frames-result") {
		await writeAtomic(path.join(WORKSPACE, "frames-result.json"), JSON.stringify(await req.json(), null, 1));
		return Response.json({ ok: true });
	}
	// Agent exports (see AGENT.md): progress and errors, and the video with its final answer.
	if (slug[0] === "export-result") return handleExportResult(req, WORKSPACE);
	if (slug[0] === "export-file") return handleExportFile(req, WORKSPACE);
	if (slug[0] === "changes-result") {
		// What changed since a snapshot, or for a draft; see AGENT.md.
		const text = await req.text();
		if (text.length > 16 * 1024 * 1024) return Response.json({ error: "Changes too large" }, { status: 413 });
		await writeAtomic(path.join(WORKSPACE, "changes-result.json"), JSON.stringify(JSON.parse(text), null, 1));
		return Response.json({ ok: true });
	}
	if (slug[0] === "sync") {
		await writeWorkspaceSnapshot(WORKSPACE, await req.json());
		return Response.json({ ok: true });
	}
	if (slug[0] === "edits") {
		const lines = await req.json();
		if (!Array.isArray(lines) || !lines.length || lines.some((line) => typeof line.projectId !== "string" || !/^[a-zA-Z0-9-]+$/.test(line.projectId) || line.projectId !== lines[0].projectId || line.actor !== "user")) return Response.json({ error: "Invalid log" }, { status: 400 });
		const dir = path.join(WORKSPACE, "edits");
		await fs.mkdir(dir, { recursive: true });
		await fs.appendFile(path.join(dir, `${lines[0].projectId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
		return Response.json({ ok: true });
	}
	if (slug[0] === "selection") {
		// What the user points at right now (selected elements + playhead); see AGENT.md.
		const text = await req.text();
		if (text.length > 4 * 1024 * 1024) return Response.json({ error: "Selection too large" }, { status: 413 });
		let body: unknown = null;
		try {
			body = JSON.parse(text);
		} catch {
			// handled below
		}
		const selection = parseSelectionPayload(body);
		if (!selection) return Response.json({ error: "Invalid selection" }, { status: 400 });
		await writeAtomic(path.join(WORKSPACE, "selection.json"), JSON.stringify(selection, null, 1));
		return Response.json({ ok: true });
	}
	if (slug[0] === "applied") {
		const result = await req.json();
		await writeAtomic(path.join(WORKSPACE, "draft-result.json"), JSON.stringify(result, null, 1));
		// A draft is applied once: move it aside so a project opened later does not apply it again.
		await consumeAppliedDraft(WORKSPACE, result?.rev);
		return Response.json({ ok: true });
	}
	if (slug[0] === "music") {
		// Songs from the music folders, or found or linked online (sound only, via yt-dlp); see AGENT.md.
		const result = await handleMusic(await req.json().catch(() => null), { filesRoot: FILES_ROOT });
		return Response.json(result.body, { status: result.status });
	}
	if (slug[0] === "duck") {
		// Volume keyframes that lower a music element while voices speak; see AGENT.md.
		const result = await handleDuck(await req.json().catch(() => null), { filesRoot: FILES_ROOT });
		return Response.json(result.body, { status: result.status });
	}
	if (slug[0] === "sfx") {
		// Sound effects from the library folders and myinstants.com; see AGENT.md.
		const result = await handleSfx(await req.json().catch(() => null), { filesRoot: FILES_ROOT });
		return Response.json(result.body, { status: result.status });
	}
	if (slug[0] === "retrieve") {
		// A section of an online video (or one frame of it) into AGENT_FILES_ROOT/retrieved/; see AGENT.md.
		const result = await handleRetrieve(await req.json().catch(() => null), { filesRoot: FILES_ROOT });
		return Response.json(result.body, { status: result.status });
	}
	if (slug[0] === "gif") return handleGif(req);
	return Response.json({ error: "Not found" }, { status: 404 });
}
