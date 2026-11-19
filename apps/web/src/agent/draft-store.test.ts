import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { consumeAppliedDraft } from "./draft-store";

describe("drafts are applied once", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "drafts-"));
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("the applied draft moves out of draft.json", async () => {
		await fs.writeFile(path.join(dir, "draft.json"), JSON.stringify({ rev: "r1", ops: [] }));
		const moved = await consumeAppliedDraft(dir, "r1");
		expect(moved).not.toBeNull();
		expect(await fs.readdir(dir)).toEqual(["drafts-applied"]);
		expect(JSON.parse(await fs.readFile(moved as string, "utf8")).rev).toBe("r1");
	});

	test("a newer draft written meanwhile stays", async () => {
		await fs.writeFile(path.join(dir, "draft.json"), JSON.stringify({ rev: "r2", ops: [] }));
		expect(await consumeAppliedDraft(dir, "r1")).toBeNull();
		expect(JSON.parse(await fs.readFile(path.join(dir, "draft.json"), "utf8")).rev).toBe("r2");
	});

	test("missing draft, bad JSON or no rev do nothing", async () => {
		expect(await consumeAppliedDraft(dir, "r1")).toBeNull();
		await fs.writeFile(path.join(dir, "draft.json"), "{not json");
		expect(await consumeAppliedDraft(dir, "r1")).toBeNull();
		expect(await consumeAppliedDraft(dir, undefined)).toBeNull();
		expect(await fs.readFile(path.join(dir, "draft.json"), "utf8")).toBe("{not json");
	});

	test("a newer draft written between the check and the move is not moved", async () => {
		const draft = path.join(dir, "draft.json");
		await fs.writeFile(draft, JSON.stringify({ rev: "r1" }));
		const moved = await consumeAppliedDraft(dir, "r1", { beforeClaim: () => fs.writeFile(draft, JSON.stringify({ rev: "r2" })) });
		expect(moved).toBeNull();
		expect(JSON.parse(await fs.readFile(draft, "utf8")).rev).toBe("r2");
		expect((await fs.readdir(path.join(dir, "drafts-applied"))).filter((f) => f.startsWith(".claim"))).toEqual([]);
	});

	test("an even newer draft written while the claimed one was away wins; the claimed one is kept aside", async () => {
		const draft = path.join(dir, "draft.json");
		await fs.writeFile(draft, JSON.stringify({ rev: "r1" }));
		const moved = await consumeAppliedDraft(dir, "r1", {
			beforeClaim: () => fs.writeFile(draft, JSON.stringify({ rev: "r2" })),
			afterClaim: () => fs.writeFile(draft, JSON.stringify({ rev: "r3" })),
		});
		expect(moved).toBeNull();
		expect(JSON.parse(await fs.readFile(draft, "utf8")).rev).toBe("r3");
		const aside = await fs.readdir(path.join(dir, "drafts-applied"));
		expect(aside).toHaveLength(1);
		expect(aside[0]).toMatch(/^superseded-/);
		expect(JSON.parse(await fs.readFile(path.join(dir, "drafts-applied", aside[0]), "utf8")).rev).toBe("r2");
	});

	test("odd revs make a safe file name", async () => {
		await fs.writeFile(path.join(dir, "draft.json"), JSON.stringify({ rev: "../../x y" }));
		const moved = await consumeAppliedDraft(dir, "../../x y");
		expect(path.dirname(moved as string)).toBe(path.join(dir, "drafts-applied"));
		expect(path.basename(moved as string)).toMatch(/^______x_y-\d+\.json$/);
	});
});
