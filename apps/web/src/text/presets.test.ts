import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { GET, POST } from "@/app/api/agent/presets/route";
import { applyTextPreset, createTextPreset, validateTextPreset } from "./presets";
import { presetFileName } from "./preset-files";
import { upsertPathKeyframe } from "@/animation";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { buildTextElement } from "@/timeline/element-utils";
import { ZERO_MEDIA_TIME } from "@/wasm";

test("workspace preset API saves, reloads, replaces and applies a named style", async () => {
	const workspace = await fs.mkdtemp(
		path.join(os.tmpdir(), "caption-presets-"),
	);
	const previous = process.env.AGENT_WORKSPACE;
	process.env.AGENT_WORKSPACE = workspace;
	try {
		const save = (style: Record<string, string | number>) =>
			POST(
				new Request("http://localhost/api/agent/presets", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Readable", style }),
				}),
			);
		expect(
			(await save({ fontSize: 8, "stroke.inner.width": 0.1 })).status,
		).toBe(200);
		expect(
			(await save({ fontSize: 10, "stroke.inner.width": 0.2 })).status,
		).toBe(200);
		const list = await (await GET()).json();
		expect(list).toHaveLength(1);
		const preset = validateTextPreset(list[0]);
		const element = {
			...buildTextElement({
				raw: { params: { content: "Still editable" } },
				startTime: ZERO_MEDIA_TIME,
			}),
			id: "text",
		};
		expect(applyTextPreset(element, preset).params).toMatchObject({
			content: "Still editable",
			fontSize: 10,
			"stroke.inner.width": 0.2,
		});
		expect((await save({ fontSize: "wrong type" })).status).toBe(400);
	} finally {
		if (previous === undefined) delete process.env.AGENT_WORKSPACE;
		else process.env.AGENT_WORKSPACE = previous;
		await fs.rm(workspace, { recursive: true, force: true });
	}
});

async function withWorkspace(run: (workspace: string) => Promise<void>) {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "caption-presets-"));
	const previous = process.env.AGENT_WORKSPACE;
	process.env.AGENT_WORKSPACE = workspace;
	try {
		await run(workspace);
	} finally {
		if (previous === undefined) delete process.env.AGENT_WORKSPACE;
		else process.env.AGENT_WORKSPACE = previous;
		await fs.rm(workspace, { recursive: true, force: true });
	}
}

const post = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
	POST(new Request("http://localhost:3000/api/agent/presets", { method: "POST", headers: { host: "localhost:3000", ...headers }, body: JSON.stringify(body) }));

test("only the editor's own origin may save presets, as JSON", async () => {
	await withWorkspace(async () => {
		const preset = { name: "Readable", style: { fontSize: 8 } };
		expect((await post(preset, { "Content-Type": "application/json", Origin: "http://localhost:5173" })).status).toBe(403);
		expect((await post(preset, { "Content-Type": "text/plain" })).status).toBe(415);
		expect((await post(preset, { "Content-Type": "application/json", Origin: "http://localhost:3000" })).status).toBe(200);
		expect((await post(preset)).status).toBe(200);
	});
});

test("names that differ only in case get their own files; a file declaring the name is replaced in place", async () => {
	expect(presetFileName("Readable")).not.toBe(presetFileName("readable"));
	expect(presetFileName("Readable").toLowerCase()).not.toBe(presetFileName("readable").toLowerCase());
	expect(presetFileName("../../a b")).toMatch(/^a-b-[0-9a-f]{10}\.json$/);
	await withWorkspace(async (workspace) => {
		const dir = path.join(workspace, "presets");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "custom.json"), JSON.stringify({ name: "Readable", style: { fontSize: 5 } }));
		await fs.writeFile(path.join(dir, "broken.json"), "{not json");
		expect((await post({ name: "Readable", style: { fontSize: 9 } })).status).toBe(200);
		expect((await post({ name: "readable", style: { fontSize: 4 } })).status).toBe(200);
		const files = (await fs.readdir(dir)).sort();
		expect(files).toHaveLength(3);
		expect(JSON.parse(await fs.readFile(path.join(dir, "custom.json"), "utf8")).style.fontSize).toBe(9);
		// An unreadable file does not hide the others.
		const list = (await (await GET()).json()) as { name: string }[];
		expect(list.map((p) => p.name).sort()).toEqual(["Readable", "readable"]);
	});
});

test("a preset taken while an animated pixel stroke is 0 keeps the stroke off", () => {
	const plain = {
		...buildTextElement({ raw: { params: { content: "x", "stroke.outer.width": 0.2, "stroke.outer.widthPx": 6 } }, startTime: ZERO_MEDIA_TIME }),
		id: "text",
	};
	const target = resolveAnimationTarget({ element: plain, path: "stroke.outer.widthPx" });
	expect(target).not.toBeNull();
	const animations = upsertPathKeyframe({
		animations: undefined,
		propertyPath: "stroke.outer.widthPx",
		time: ZERO_MEDIA_TIME,
		value: 0,
		channelLayout: target!.channelLayout,
		coerceValue: target!.coerceValue,
	});
	const preset = createTextPreset("Off", { ...plain, animations }, 0);
	expect(preset.style["stroke.outer.widthPx"]).toBe(0);
	expect(preset.style["stroke.outer.width"]).toBe(0);
	// Without the animation, a 0 pixel width means "use the em width", which stays.
	const still = createTextPreset("On", { ...plain, params: { ...plain.params, "stroke.outer.widthPx": 0 } }, 0);
	expect(still.style["stroke.outer.width"]).toBe(0.2);
});
