// What an agent left in the workspace that the person has not opened yet, for the home page:
// the bundle (bundle/bundle.json) until it is imported, and the draft (draft.json) until an editor answers it.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "@/services/storage/server/files";
import { readTextLimited } from "./export-server";
import { BUNDLE_REV_HEADER, type Inbox, type InboxBundle, type InboxDraft } from "./inbox-types";

const IMPORTED_FILE = "bundle-imported.json";

const bundleFile = (workspace: string) => path.join(workspace, "bundle", "bundle.json");
const revOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readFile(file: string): Promise<{ bytes: Buffer; modifiedAt: string } | null> {
	try {
		const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
		return { bytes, modifiedAt: stat.mtime.toISOString() };
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
}

async function importedRev(workspace: string): Promise<string | null> {
	try {
		const record = JSON.parse(await fs.readFile(path.join(workspace, IMPORTED_FILE), "utf8")) as { rev?: unknown };
		return typeof record?.rev === "string" ? record.rev : null;
	} catch {
		return null;
	}
}

const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);
const size = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null);

async function readBundle(workspace: string): Promise<InboxBundle | null> {
	const file = await readFile(bundleFile(workspace));
	if (!file) return null;
	const rev = revOf(file.bytes);
	if ((await importedRev(workspace)) === rev) return null;
	let bundle: Record<string, unknown>;
	try {
		bundle = JSON.parse(file.bytes.toString("utf8"));
		if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("it is not a JSON object");
	} catch (error) {
		return { rev, modifiedAt: file.modifiedAt, error: `bundle/bundle.json cannot be read: ${message(error)}` };
	}
	const overlay = Array.isArray(bundle.overlay) ? bundle.overlay : [];
	return {
		rev, modifiedAt: file.modifiedAt,
		name: typeof bundle.name === "string" && bundle.name.trim() ? bundle.name : "bundle",
		assets: count(bundle.assets),
		items: count(bundle.main) + count(bundle.audio) + overlay.reduce((sum: number, track) => sum + count((track as { elements?: unknown })?.elements), 0),
		width: size(bundle.width), height: size(bundle.height),
	};
}

async function readDraft(workspace: string): Promise<InboxDraft | null> {
	const file = await readFile(path.join(workspace, "draft.json"));
	if (!file) return null;
	let draft: Record<string, unknown>;
	try {
		draft = JSON.parse(file.bytes.toString("utf8"));
		if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error("it is not a JSON object");
	} catch (error) {
		return { modifiedAt: file.modifiedAt, error: `draft.json cannot be read: ${message(error)}` };
	}
	// The editor skips a draft without a rev.
	if (typeof draft.rev !== "string" || !draft.rev) return { modifiedAt: file.modifiedAt, error: "draft.json has no rev, so no editor applies it." };
	// Answered already (an editor posted its result, but the file was not moved aside).
	const result = await fs.readFile(path.join(workspace, "draft-result.json"), "utf8").then(JSON.parse).catch(() => null);
	if (result?.rev === draft.rev) return null;
	return {
		modifiedAt: file.modifiedAt, rev: draft.rev,
		projectId: typeof draft.projectId === "string" && draft.projectId ? draft.projectId : null,
		label: typeof draft.label === "string" && draft.label.trim() ? draft.label : null,
		ops: count(draft.ops),
	};
}

export async function readInbox(workspace: string): Promise<Inbox> {
	const [bundle, draft] = await Promise.all([
		readBundle(workspace).catch((error): InboxBundle => ({ rev: "", modifiedAt: "", error: message(error) })),
		readDraft(workspace).catch((error): InboxDraft => ({ modifiedAt: "", error: message(error) })),
	]);
	return { bundle, draft };
}

/** GET /api/agent/bundle: bundle.json as it is, with the version it is. */
export async function bundleResponse(workspace: string): Promise<Response> {
	const file = await readFile(bundleFile(workspace));
	if (!file) return Response.json({ error: "No bundle: write bundle/bundle.json in the agent workspace first." }, { status: 404 });
	return new Response(new Uint8Array(file.bytes), {
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store", [BUNDLE_REV_HEADER]: revOf(file.bytes) },
	});
}

/** POST /api/agent/bundle-imported `{rev, projectId}`: that version of the bundle is a project now, and leaves the home page. */
export async function markBundleImported(req: Request, workspace: string): Promise<Response> {
	const text = await readTextLimited(req, 4096);
	let body: { rev?: unknown; projectId?: unknown } | null = null;
	try {
		body = text === null ? null : JSON.parse(text);
	} catch {
		// handled below
	}
	if (typeof body?.rev !== "string" || !/^[0-9a-f]{64}$/.test(body.rev) || typeof body.projectId !== "string" || !/^[\w-]{1,128}$/.test(body.projectId)) {
		return Response.json({ error: "Send {rev, projectId}: the bundle's rev and the new project's id." }, { status: 400 });
	}
	const record = { rev: body.rev, projectId: body.projectId, importedAt: new Date().toISOString() };
	await atomicWrite(path.join(workspace, IMPORTED_FILE), JSON.stringify(record, null, 1));
	return Response.json({ ok: true });
}
