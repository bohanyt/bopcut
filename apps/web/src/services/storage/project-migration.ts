import { CURRENT_PROJECT_VERSION, migrations } from "./migrations";
import type { ProjectRecord } from "./migrations/transformers/types";
import type { SerializedProject } from "./types";

export async function migrateProject(project: ProjectRecord, id: string, version: number) {
	if (!Number.isInteger(version) || version < 0 || version > CURRENT_PROJECT_VERSION) {
		throw new Error("The saved project has an unsupported version. Open it with a compatible editor and save it again.");
	}
	for (const migration of migrations) {
		if (migration.from !== version) continue;
		const result = await migration.run({ projectId: id, project });
		if (result.skipped) throw new Error(`Project migration ${id}: ${result.reason ?? "failed"}`);
		project = result.project;
		version = migration.to;
	}
	return project as unknown as SerializedProject;
}
