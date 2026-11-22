import { promises as fs } from "node:fs";
import path from "node:path";
import { projectDir, readJson } from "@/services/storage/server/files";
import { isForeignOrigin } from "./origin";

type Snapshot = { projectId?: string; notes?: unknown; syncedAt?: string };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

async function preference(root?: string) {
	if (!root) return { missing: true, content: null };
	try { return { missing: false, content: await fs.readFile(path.join(root, "PREFERENCES.md"), "utf8") }; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { missing: true, content: null };
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
		if (action === "prefs") return json({ general: await preference(process.env.AGENT_PREFS), workspace: await preference(workspace) });
		if (action === "selection") {
			const selected = await readJson(path.join(workspace, "selection.json"));
			return json({ selection: !requested || requested === selected?.projectId ? selected : null });
		}
		if (action === "status" || action === "notes") {
			const latest: Snapshot | null = requested ? null : await readJson(path.join(workspace, "project.json"));
			const projectId = requested ?? latest?.projectId;
			if (!projectId || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) {
				return json({ error: "No project has synced yet. Open a project in the editor or pass --project-id." }, 404);
			}
			try { await fs.access(path.join(projectDir(projectId), "project.json")); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return json({ error: "Project was not found on disk. Open it in the editor or pass a valid --project-id." }, 404);
			}
			const key = projectId.replaceAll("_", "");
			const byProject: Snapshot | null = await readJson(path.join(workspace, "sync", key + ".json"));
			const snapshot = byProject?.projectId === projectId ? byProject : latest;
			return json(action === "status"
				? { projectId, snapshot }
				: { projectId, notes: snapshot?.notes ?? [], syncedAt: snapshot?.syncedAt ?? null });
		}
	} catch {
		return json({ error: "Could not read editor data. Check that the workspace files are readable and retry." }, 500);
	}
	return json({ error: "Use status, selection, notes, or prefs." }, 404);
}
