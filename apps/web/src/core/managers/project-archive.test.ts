import { afterEach, expect, spyOn, test } from "bun:test";
import { EditorCore } from "@/core";
import { storageService } from "@/services/storage/service";
import type { TProjectMetadata } from "@/project/types";
import { t } from "@/timeline/__tests__/compound-fixtures";

const restore: Array<() => void> = [];
afterEach(() => {
	for (const undo of restore.splice(0)) undo();
	EditorCore.reset();
});
const meta = (id: string, minutes: number): TProjectMetadata => ({
	id, name: id, duration: t(1), createdAt: new Date(0), updatedAt: new Date(minutes * 60_000),
});
function stub<T extends object, K extends keyof T>(target: T, key: K, value: T[K] extends (...args: never[]) => infer R ? Awaited<R> | Error : never) {
	const spy = spyOn(target, key as never).mockImplementation((async () => {
		if (value instanceof Error) throw value;
		return value;
	}) as never);
	restore.push(() => spy.mockRestore());
	return spy;
}

async function load(archived: string[] | Error) {
	const editor = EditorCore.getInstance();
	editor.save.stop();
	spyOn(editor.project as never, "ensureStorageMigrations").mockResolvedValue(undefined as never);
	stub(storageService, "loadAllProjectsMetadata", [meta("a", 3), meta("b", 2), meta("c", 1)]);
	stub(storageService, "loadArchivedProjectIds", archived);
	await editor.project.loadAllProjects();
	const list = (inArchive: boolean) => editor.project
		.getFilteredAndSortedProjects({ searchQuery: "", sortOption: "updatedAt-desc", archived: inArchive })
		.map(({ id }) => id);
	return { editor, list };
}

test("archived projects leave the list for their own view and come back", async () => {
	const { editor, list } = await load(["b"]);
	expect([list(false), list(true), editor.project.getArchivedCount()]).toEqual([["a", "c"], ["b"], 1]);
	const write = stub(storageService, "setProjectsArchived", ["b", "a"]);
	expect(await editor.project.setProjectsArchived({ ids: ["a"], archived: true })).toBe(true);
	expect(write).toHaveBeenCalledWith({ ids: ["a"], archived: true });
	expect([list(false), list(true)]).toEqual([["c"], ["a", "b"]]);
});

test("without the archive list every project shows, and a failed change keeps the lists as they were", async () => {
	const { editor, list } = await load(new Error("Storage failed (500)"));
	expect(list(false)).toEqual(["a", "b", "c"]);
	stub(storageService, "setProjectsArchived", new Error("Storage failed (500)"));
	expect(await editor.project.setProjectsArchived({ ids: ["a"], archived: true })).toBe(false);
	expect([list(false), list(true)]).toEqual([["a", "b", "c"], []]);
});
