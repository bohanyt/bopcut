import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunningBrowser } from "./hidden-browser";
import { closeHiddenEditor, hiddenEditorProject, openHiddenEditor } from "./hidden-editor";

let workspace: string;
let launched: { url: string; profile: string; stopped: boolean; exit: () => void }[];
const launch = (url: string, profile: string): RunningBrowser => {
	let exit!: () => void;
	const exited = new Promise<void>((resolve) => { exit = resolve; });
	const entry = { url, profile, stopped: false, exit };
	launched.push(entry);
	return { exited, stop: async () => { entry.stopped = true; exit(); } };
};
const open = (projectId: string, idleMs = 40) =>
	openHiddenEditor({ projectId, origin: "http://127.0.0.1:3000", workspace, launch, profileRoot: workspace, idleMs, maxMs: 5000 });
const write = (name: string, value: unknown) => fs.writeFile(path.join(workspace, name), JSON.stringify(value));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hidden-editor-"));
	launched = [];
});
afterEach(async () => {
	await closeHiddenEditor();
	await fs.rm(workspace, { recursive: true, force: true });
});

test("the project opens once in its own browser profile, and a second draft reuses it", async () => {
	await write("draft.json", { rev: "a", projectId: "p1" });
	expect(await open("p1")).toBe("opened");
	expect(await open("p1")).toBe("running");
	expect(launched).toHaveLength(1);
	expect(launched[0].url).toBe("http://127.0.0.1:3000/editor/p1");
	expect(launched[0].profile).toBe(path.join(workspace, ".draft-browser"));
	expect(hiddenEditorProject()).toBe("p1");
});

test("it stays open while a draft waits or its result is not saved, then closes when idle", async () => {
	await write("draft.json", { rev: "a", projectId: "p1" });
	await open("p1");
	await wait(100);
	expect(launched[0].stopped).toBe(false);
	await fs.rm(path.join(workspace, "draft.json"));
	await write("draft-result.json", { rev: "a", projectId: "p1", applied: true, saved: false });
	await wait(100);
	expect(launched[0].stopped).toBe(false);
	await write("draft-result.json", { rev: "a", projectId: "p1", applied: true, saved: true });
	await wait(100);
	expect(launched[0].stopped).toBe(true);
	expect(hiddenEditorProject()).toBeUndefined();
});

test("another project waits while the open one still has a draft, and replaces it once that is done", async () => {
	await write("draft.json", { rev: "a", projectId: "p1" });
	await open("p1", 5000);
	expect(await open("p2", 5000)).toBe("busy");
	await write("draft.json", { rev: "b", projectId: "p2" });
	expect(await open("p2", 5000)).toBe("opened");
	expect(launched.map(({ url, stopped }) => [url.split("/").pop(), stopped])).toEqual([["p1", true], ["p2", false]]);
});

test("a browser that exits by itself is forgotten, so the next draft opens a new one", async () => {
	await write("draft.json", { rev: "a", projectId: "p1" });
	await open("p1", 5000);
	launched[0].exit();
	await wait(10);
	expect(hiddenEditorProject()).toBeUndefined();
	expect(await open("p1", 5000)).toBe("opened");
	expect(launched).toHaveLength(2);
});
