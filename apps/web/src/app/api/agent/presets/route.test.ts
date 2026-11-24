import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { GET, POST } from "./route";

test("duplicate preset names list once and a save replaces the listed file", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "caption-presets-"));
	const previous = process.env.AGENT_WORKSPACE;
	process.env.AGENT_WORKSPACE = workspace;
	try {
		const dir = path.join(workspace, "presets");
		await fs.mkdir(dir, { recursive: true });
		for (const [file, name, fontSize] of [
			["first-readable.json", "Readable", 5],
			["second-readable.json", "Readable", 6],
			["lower.json", "readable", 4],
		] as const) {
			await fs.writeFile(path.join(dir, file), JSON.stringify({ name, style: { fontSize } }));
		}
		const list = (await (await GET()).json()) as { name: string; style: { fontSize: number } }[];
		expect(list.filter((p) => p.name === "Readable")).toHaveLength(1);
		expect(list.find((p) => p.name === "Readable")?.style.fontSize).toBe(5);
		const res = await POST(
			new Request("http://localhost:3000/api/agent/presets", {
				method: "POST",
				headers: { "Content-Type": "application/json", host: "localhost:3000" },
				body: JSON.stringify({ name: "Readable", style: { fontSize: 11 } }),
			}),
		);
		expect(res.status).toBe(200);
		const saved = (await (await GET()).json()) as typeof list;
		expect(saved.map((p) => [p.name, p.style.fontSize])).toEqual([["Readable", 11], ["readable", 4]]);
		expect(JSON.parse(await fs.readFile(path.join(dir, "second-readable.json"), "utf8")).style.fontSize).toBe(6);
	} finally {
		if (previous === undefined) delete process.env.AGENT_WORKSPACE;
		else process.env.AGENT_WORKSPACE = previous;
		await fs.rm(workspace, { recursive: true, force: true });
	}
});