import { afterEach, expect, spyOn, test } from "bun:test";
import { EditorCore } from "@/core";
import { storageService } from "@/services/storage/service";
import { buildNewProject } from "@/project/create";
import type { TProjectMetadata } from "@/project/types";
import { t } from "@/timeline/__tests__/compound-fixtures";

const restore: Array<() => void> = [];
afterEach(() => {
	for (const undo of restore.splice(0)) undo();
	EditorCore.reset();
});
const meta = (id: string, extra: Partial<TProjectMetadata> = {}): TProjectMetadata => ({
	id, name: id, duration: t(1), createdAt: new Date(0), updatedAt: new Date(0), ...extra,
});
function spy<T extends object>(target: T, key: keyof T, implementation: (...args: never[]) => unknown) {
	const stub = spyOn(target, key as never).mockImplementation(implementation as never);
	restore.push(() => stub.mockRestore());
	return stub;
}
async function editorWith(projects: TProjectMetadata[]) {
	const editor = EditorCore.getInstance();
	editor.save.stop();
	spy(editor.project, "ensureStorageMigrations" as never, async () => {});
	spy(storageService, "loadAllProjectsMetadata", async () => projects);
	spy(storageService, "loadArchivedProjectIds", async () => []);
	await editor.project.loadAllProjects();
	return editor;
}

test("a new project can carry a mode, and a closed project's mode changes on its stored copy", async () => {
	expect(buildNewProject({ name: "Clip", mode: "editing" }).metadata.mode).toBe("editing");
	expect("mode" in buildNewProject({ name: "Clip" }).metadata).toBe(false);

	const editor = await editorWith([meta("a"), meta("b")]);
	spy(editor.save, "settleProject", async () => null);
	const write = spy(storageService, "setProjectMode", async ({ id, mode }: { id: string; mode: string | null }) =>
		meta(id, mode ? { mode: mode as never } : {}));
	expect(await editor.project.setProjectMode({ id: "a", mode: "creating" })).toBe(true);
	expect(write).toHaveBeenCalledWith({ id: "a", mode: "creating" });
	expect(editor.project.getSavedProjects().find(({ id }) => id === "a")?.mode).toBe("creating");
	expect(await editor.project.setProjectMode({ id: "a", mode: null })).toBe(true);
	expect("mode" in editor.project.getSavedProjects().find(({ id }) => id === "a")!).toBe(false);
});

test("the open project's mode changes in the editor and is saved by its session", async () => {
	const editor = await editorWith([]);
	const project = buildNewProject({ name: "Open" });
	editor.project.setActiveProject({ project });
	const flush = spy(editor.save, "flush", async () => true);
	const write = spy(storageService, "setProjectMode", async () => null);
	expect(await editor.project.setProjectMode({ id: project.metadata.id, mode: "generating" })).toBe(true);
	expect(editor.project.getActive().metadata.mode).toBe("generating");
	expect(flush).toHaveBeenCalledTimes(1);
	expect(write).not.toHaveBeenCalled();
});

test("a failed change says so and keeps the mode", async () => {
	const editor = await editorWith([meta("a", { mode: "editing" })]);
	spy(editor.save, "settleProject", async () => null);
	spy(storageService, "setProjectMode", async () => { throw new Error("Storage failed (500)"); });
	expect(await editor.project.setProjectMode({ id: "a", mode: "creating" })).toBe(false);
	expect(editor.project.getSavedProjects()[0].mode).toBe("editing");
});
