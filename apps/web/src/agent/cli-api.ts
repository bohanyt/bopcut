import { promises as fs } from "node:fs";
import path from "node:path";
import { projectDir, readJson } from "@/services/storage/server/files";
import { fileInside } from "./inside";
import { isForeignOrigin } from "./origin";

type Snapshot = { projectId?: string; notes?: unknown; syncedAt?: string };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

const readInside = async (root: string, ...parts: string[]) => {
	const file = await fileInside(root, ...parts);
	return file ? readJson(file) : null;
};

/** A snapshot that is not valid JSON counts as missing here, so the other snapshot can answer. Links still fail. */
async function readSnapshot(workspace: string, ...parts: string[]): Promise<Snapshot | null> {
	try { return await readInside(workspace, ...parts); }
	catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

export async function handleCli(req: Request, action: string, workspace: string): Promise<Response> {
	const url = new URL(req.url);
	if (!["localhost", "127.0.0.1"].includes(url.hostname) || isForeignOrigin(req) || req.headers.get("sec-fetch-site") === "cross-site") {
		return json({ error: "Use the agent CLI on the local editor server." }, 403);
	}
	const requested = url.searchParams.get("projectId");
	if (requested !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(requested)) {
		return json({ error: "Pass a valid --project-id or open a project in the editor." }, 400);
	}
	try {
		if (action === "selection") {
			const selected = await readInside(workspace, "selection.json");
			return json({ selection: !requested || requested === selected?.projectId ? selected : null });
		}
		if (action === "status" || action === "notes") {
			// A plain request answers from the last synced snapshot. A chosen project reads its own snapshot
			// first and falls back to the last synced one when that is the same project.
			const latest: Snapshot | null = requested ? null : await readInside(workspace, "project.json");
			const projectId = requested ?? latest?.projectId;
			if (!projectId || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) {
				return json({ error: "No project has synced yet. Open a project in the editor or pass --project-id." }, 404);
			}
			try { await fs.access(path.join(projectDir(projectId), "project.json")); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return json({ error: "Project was not found on disk. Open it in the editor or pass a valid --project-id." }, 404);
			}
			let snapshot = latest;
			if (requested) {
				const own = await readSnapshot(workspace, "sync", projectId.replaceAll("_", "") + ".json");
				const found = own?.projectId === projectId ? own : await readSnapshot(workspace, "project.json");
				snapshot = found?.projectId === projectId ? found : null;
			}
			return json(action === "status"
				? { projectId, snapshot }
				: { projectId, notes: snapshot?.notes ?? [], syncedAt: snapshot?.syncedAt ?? null });
		}
	} catch {
		return json({ error: "Could not read editor data. Check that the workspace files are readable and retry." }, 500);
	}
	return json({ error: "Use status, selection, or notes." }, 404);
}
