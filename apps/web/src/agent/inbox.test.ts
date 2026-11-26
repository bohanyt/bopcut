import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleResponse, markBundleImported, readInbox } from "./inbox";
import { BUNDLE_REV_HEADER } from "./inbox-types";

let dir: string;
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-"));
});
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const bundle = {
	name: "Interview cut", width: 1080, height: 1920,
	assets: [{ key: "a" }, { key: "b" }],
	main: [{ agent_id: "one" }, { agent_id: "two" }], audio: [{ agent_id: "music" }],
	overlay: [{ name: "Text", type: "text", elements: [{ agent_id: "title" }, { agent_id: "caption" }] }],
};
const writeBundle = async (data: unknown) => {
	await fs.mkdir(path.join(dir, "bundle"), { recursive: true });
	const text = typeof data === "string" ? data : JSON.stringify(data);
	await fs.writeFile(path.join(dir, "bundle", "bundle.json"), text);
	return createHash("sha256").update(text).digest("hex");
};
const mark = (body: unknown) => markBundleImported(new Request("http://127.0.0.1:3000/api/agent/bundle-imported", {
	method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
}), dir);

test("an empty workspace has nothing from the agent", async () => {
	expect(await readInbox(dir)).toEqual({ bundle: null, draft: null });
	const missing = await bundleResponse(dir);
	expect(missing.status).toBe(404);
	expect((await missing.json()).error).toContain("bundle/bundle.json");
});

test("a bundle is listed until the version read is imported, and again once the agent writes another", async () => {
	const rev = await writeBundle(bundle);
	expect((await readInbox(dir)).bundle).toEqual({
		rev, modifiedAt: expect.any(String), name: "Interview cut", assets: 2, items: 5, width: 1080, height: 1920,
	});
	const response = await bundleResponse(dir);
	expect(response.headers.get(BUNDLE_REV_HEADER)).toBe(rev);
	expect(await response.json()).toEqual(bundle);

	expect((await mark({ rev, projectId: "project-1" })).status).toBe(200);
	expect(JSON.parse(await fs.readFile(path.join(dir, "bundle-imported.json"), "utf8"))).toMatchObject({ rev, projectId: "project-1" });
	expect((await readInbox(dir)).bundle).toBeNull();

	const next = await writeBundle({ ...bundle, name: "Second cut" });
	expect((await readInbox(dir)).bundle).toMatchObject({ rev: next, name: "Second cut" });
});

test("a bundle that cannot be read says why", async () => {
	const rev = await writeBundle("{ not json");
	const listed = (await readInbox(dir)).bundle;
	expect(listed).toMatchObject({ rev });
	expect(listed && "error" in listed && listed.error).toContain("bundle/bundle.json cannot be read");
	await writeBundle([1, 2]);
	expect((await readInbox(dir)).bundle).toMatchObject({ error: expect.stringContaining("not a JSON object") });
	// Missing fields count as none.
	await writeBundle({});
	expect((await readInbox(dir)).bundle).toMatchObject({ name: "bundle", assets: 0, items: 0, width: null, height: null });
});

test("an import is recorded only for a bundle rev and a project id", async () => {
	const rev = "a".repeat(64);
	for (const body of [{ rev: "abc", projectId: "p" }, { rev, projectId: "../p" }, { rev }, "not json", JSON.stringify({ rev, projectId: "p", pad: "x".repeat(5000) })]) {
		expect((await mark(body)).status).toBe(400);
	}
	expect(await fs.readdir(dir)).toEqual([]);
});

test("a draft is listed until an editor answers it", async () => {
	const draft = { rev: "r1", projectId: "project-1", label: "Tighten the intro", ops: [{}, {}, {}] };
	await fs.writeFile(path.join(dir, "draft.json"), JSON.stringify(draft));
	expect((await readInbox(dir)).draft).toEqual({ rev: "r1", projectId: "project-1", label: "Tighten the intro", ops: 3, modifiedAt: expect.any(String) });
	// Without a project or label: it applies to whichever project opens next.
	await fs.writeFile(path.join(dir, "draft.json"), JSON.stringify({ rev: "r2", ops: [] }));
	expect((await readInbox(dir)).draft).toMatchObject({ rev: "r2", projectId: null, label: null, ops: 0 });
	// An editor answered it, but the file was not moved aside.
	await fs.writeFile(path.join(dir, "draft-result.json"), JSON.stringify({ rev: "r2", applied: false }));
	expect((await readInbox(dir)).draft).toBeNull();
});

test("a draft no editor would apply says why", async () => {
	await fs.writeFile(path.join(dir, "draft.json"), JSON.stringify({ ops: [] }));
	expect((await readInbox(dir)).draft).toMatchObject({ error: expect.stringContaining("no rev") });
	await fs.writeFile(path.join(dir, "draft.json"), "{");
	expect((await readInbox(dir)).draft).toMatchObject({ error: expect.stringContaining("draft.json cannot be read") });
});
