import { afterAll, beforeAll, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DELETE, GET, PUT } from "../../../app/api/storage/[...slug]/route";

let root: string;
let previous: string | undefined;
beforeAll(async () => {
	previous = process.env.BOPENCUT_DATA;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "bopencut-archive-"));
	process.env.BOPENCUT_DATA = root;
});
afterAll(async () => {
	if (previous === undefined) delete process.env.BOPENCUT_DATA;
	else process.env.BOPENCUT_DATA = previous;
	await fs.rm(root, { recursive: true, force: true });
});

const call = (handler: typeof GET, slug: string[], method: string, body?: unknown) => handler(
	new Request(`http://127.0.0.1:3021/api/storage/${slug.join("/")}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
	{ params: Promise.resolve({ slug }) },
);
const archived = async () => (await (await call(GET, ["archived"], "GET")).json()).ids;
const createProject = async (id: string) => {
	const response = await PUT(new Request(`http://127.0.0.1:3021/api/storage/projects/${id}`, {
		method: "PUT", headers: { "if-match": "new" }, body: JSON.stringify({ metadata: { id, name: id } }),
	}), { params: Promise.resolve({ slug: ["projects", id] }) });
	expect(response.status).toBe(200);
};

test("archiving and restoring change only the archive list, never the project's files", async () => {
	await createProject("kept");
	await createProject("other");
	const projectFile = path.join(root, "projects", "kept", "project.json");
	const before = await fs.readFile(projectFile);
	expect(await archived()).toEqual([]);

	expect(await (await call(PUT, ["archived"], "PUT", { ids: ["kept", "missing"], archived: true })).json()).toEqual({ ids: ["kept"] });
	expect(await archived()).toEqual(["kept"]);
	expect(await fs.readFile(projectFile)).toEqual(before);
	// The project list still has it: the editor hides it, the agent sees it.
	const listed = await (await call(GET, ["projects"], "GET")).json();
	expect(listed.map(({ metadata }: { metadata: { id: string } }) => metadata.id).sort()).toEqual(["kept", "other"]);

	expect(await (await call(PUT, ["archived"], "PUT", { ids: ["kept"], archived: false })).json()).toEqual({ ids: [] });
	expect(await fs.readFile(projectFile)).toEqual(before);
});

test("a deleted project leaves the list, and a damaged list or a bad request changes nothing", async () => {
	await createProject("gone");
	await call(PUT, ["archived"], "PUT", { ids: ["gone"], archived: true });
	expect((await call(DELETE, ["projects", "gone"], "DELETE")).status).toBe(200);
	expect(await archived()).toEqual([]);

	for (const body of [{ ids: "gone", archived: true }, { ids: ["gone"] }, { ids: [1], archived: true }]) {
		expect((await call(PUT, ["archived"], "PUT", body)).status).toBe(400);
	}
	await fs.writeFile(path.join(root, "archived-projects.json"), "{");
	expect(await archived()).toEqual([]);
	await fs.writeFile(path.join(root, "archived-projects.json"), JSON.stringify({ ids: ["../x", "ok-id", "ok-id"] }));
	expect(await archived()).toEqual(["ok-id"]);
});
