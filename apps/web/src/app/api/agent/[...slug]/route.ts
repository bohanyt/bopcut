// Local OpenCut <-> agent bridge (AI/scripts). For local development only (127.0.0.1).
//
// AGENT_WORKSPACE   agent workspace: bundle/bundle.json, sync/<projectId>.json,
//                   project.json (last synced project), draft.json, draft-result.json
// AGENT_FILES_ROOT  bundle asset root (default = AGENT_WORKSPACE). Files outside this root are not served.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { handleRetrieve } from "@/retrieval/server";
import { handleSfx, libraryPreviewFile } from "@/sounds/sfx-server";
import { MUSIC_LIBRARY, handleMusic } from "@/sounds/music-server";
import { handleDuck } from "@/sounds/duck-server";
import { parseSelectionPayload } from "@/agent/selection-payload";
import { consumeAppliedDraft } from "@/agent/draft-store";
import { isForeignOrigin } from "@/agent/origin";
import { atomicWrite } from "@/services/storage/server/files";
import { handleExportFile, handleExportResult } from "@/agent/export-server";

const run = promisify(execFile);
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
	if (slug[0] === "frame") {
		const form = await req.formData();
		const rev = form.get("rev"); const time = form.get("time"); const image = form.get("image"); const variant = form.get("variant");
		if (typeof rev !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(rev) || typeof time !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(time) || !(image instanceof File) || image.type !== "image/jpeg" || (variant !== null && variant !== "compare")) return Response.json({ error: "Invalid frame" }, { status: 400 });
		// A compared state's frame (before/after pairs) sits next to the frame of the same time.
		const name = variant === "compare" ? `${time}-compare.jpg` : `${time}.jpg`;
		const file = `frames/${rev}/${name}`;
		await fs.mkdir(path.join(WORKSPACE, "frames", rev), { recursive: true });
		await fs.writeFile(path.join(WORKSPACE, "frames", rev, name), Buffer.from(await image.arrayBuffer()));
		return Response.json({ file });
	}
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
		const body = await req.json();
		const text = JSON.stringify(body, null, 1);
		const safe = String(body.projectId ?? "tanpa-id").replace(/[^a-zA-Z0-9-]/g, "");
		await writeAtomic(path.join(WORKSPACE, "sync", `${safe}.json`), text);
		await writeAtomic(path.join(WORKSPACE, "project.json"), text);
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
	if (slug[0] === "gif") {
		// GIF -> silent MP4 (looped 3x) for timeline animation; OpenCut renders GIFs as still images.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-gif-"));
		try {
			await fs.writeFile(path.join(dir, "in.gif"), Buffer.from(await req.arrayBuffer()));
			await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "2", "-i", path.join(dir, "in.gif"), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", path.join(dir, "out.mp4")]);
			return new Response(new Uint8Array(await fs.readFile(path.join(dir, "out.mp4"))), { headers: { "Content-Type": "video/mp4" } });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}
