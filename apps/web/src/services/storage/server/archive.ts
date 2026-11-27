import path from "node:path";
import { atomicWrite, dataRoot, readJson, statFile, withProjectLock } from "./files";
import { projectFile } from "./projects";

const PROJECT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Archived projects are only listed here, beside the projects: archiving never writes a project's own
 * files, so it cannot race the editor's saves, and restoring puts nothing back because nothing moved.
 */
const archiveFile = () => path.join(dataRoot(), "archived-projects.json");

/** The archived project IDs; a missing or damaged list is empty. */
export async function readArchivedProjectIds(): Promise<string[]> {
	const value = await readJson(archiveFile()).catch(() => null);
	const ids: unknown[] = Array.isArray(value?.ids) ? value.ids : [];
	return [...new Set(ids.filter((id): id is string => typeof id === "string" && PROJECT_ID.test(id)))];
}

/** Archives or restores projects; only an existing project is archived. Returns the new list. */
export function setProjectsArchived({ ids, archived }: { ids: string[]; archived: boolean }): Promise<string[]> {
	return withProjectLock("__archived", async () => {
		const list = new Set(await readArchivedProjectIds());
		for (const id of ids) {
			if (!PROJECT_ID.test(id)) continue;
			if (!archived) list.delete(id);
			else if (await statFile(projectFile(id))) list.add(id);
		}
		const next = [...list];
		await atomicWrite(archiveFile(), JSON.stringify({ ids: next }));
		return next;
	});
}

/** A deleted project leaves the list. */
export async function forgetArchivedProject(id: string): Promise<void> {
	if ((await readArchivedProjectIds()).includes(id)) await setProjectsArchived({ ids: [id], archived: false });
}
