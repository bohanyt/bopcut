import { promises as fs } from "node:fs";
import path from "node:path";
import { isForeignOrigin } from "@/agent/origin";
import { type TextStylePreset, validateTextPreset } from "@/text/presets";
import { presetFileName } from "@/text/preset-files";

const MAX_PRESET_BYTES = 256 * 1024;

const directory = () =>
	path.join(
		path.resolve(
			process.env.AGENT_WORKSPACE ??
				path.join(process.cwd(), "..", "..", "workspace"),
		),
		"presets",
	);

/** Every readable preset file with its declared preset; unreadable or invalid files are skipped. */
async function readPresets(): Promise<{ file: string; preset: TextStylePreset }[]> {
	await fs.mkdir(directory(), { recursive: true });
	const files = (await fs.readdir(directory()))
		.filter((file) => file.endsWith(".json"))
		.sort();
	const entries = await Promise.all(
		files.map(async (file) => {
			try {
				const preset = validateTextPreset(
					JSON.parse(await fs.readFile(path.join(directory(), file), "utf8")),
				);
				return [{ file, preset }];
			} catch {
				return [];
			}
		}),
	);
	return entries.flat();
}

export async function GET() {
	const presets: TextStylePreset[] = [];
	const seen = new Set<string>();
	for (const { preset } of await readPresets()) {
		if (seen.has(preset.name)) continue;
		seen.add(preset.name);
		presets.push(preset);
	}
	return Response.json(presets, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	if (isForeignOrigin(request))
		return Response.json({ error: "Requests must come from the editor itself" }, { status: 403 });
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
		return Response.json({ error: "Presets must be sent as application/json" }, { status: 415 });
	try {
		const text = await request.text();
		if (text.length > MAX_PRESET_BYTES)
			return Response.json({ error: "Preset too large" }, { status: 413 });
		const preset = validateTextPreset(JSON.parse(text));
		// A file that already declares this exact name is replaced, whatever its file name is.
		const existing = (await readPresets()).find((entry) => entry.preset.name === preset.name);
		const file = path.join(directory(), existing?.file ?? presetFileName(preset.name));
		const temporary = `${file}.${crypto.randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify(preset, null, 2));
			await fs.rename(temporary, file);
		} catch (error) {
			await fs.rm(temporary, { force: true }).catch(() => {});
			throw error;
		}
		return Response.json(preset);
	} catch (error) {
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Could not save preset",
			},
			{ status: 400 },
		);
	}
}
