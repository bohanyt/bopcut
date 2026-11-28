import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWrite } from "@/services/storage/server/files";
import { type AssemblePlan, assembleDraft, type LineVoice, parseScript, type VoiceWord, wavDuration } from "./assemble";
import { fileInside } from "./inside";

const VOICE_EXTENSIONS = [".wav", ".m4a", ".mp3", ".ogg", ".flac"];
/** Enough of a WAV file to reach its data chunk. */
const WAV_HEADER_BYTES = 1 << 20;

export type AssembleInput = {
	script: string;
	plan?: string;
	voices?: string;
	gap?: number;
	start?: number;
	captionPreset?: string;
	name?: string;
	/** Sends the draft to this project through the editor's MCP endpoint. */
	submit?: { origin: string; projectId: string };
};

const relative = (root: string, file: string) => path.relative(root, file).split(path.sep).join("/");

async function readInside(root: string, name: string, what: string) {
	const file = await fileInside(root, name);
	if (!file) throw new Error(`${what} ${name} is not a file under AGENT_FILES_ROOT.`);
	return file;
}

async function readWords(file: string): Promise<VoiceWord[] | undefined> {
	const sidecar = await fs.readFile(`${file}.words.json`, "utf8").catch(() => null);
	if (sidecar === null) return undefined;
	const words = JSON.parse(sidecar);
	if (!Array.isArray(words)) return undefined;
	return words.filter((word): word is VoiceWord => typeof word?.text === "string" && Number.isFinite(word.start) && Number.isFinite(word.end));
}

async function fileDuration(file: string, words?: VoiceWord[]): Promise<number | null> {
	if (file.toLowerCase().endsWith(".wav")) {
		const handle = await fs.open(file, "r");
		try {
			const buffer = new Uint8Array(WAV_HEADER_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const fromHeader = wavDuration(buffer.subarray(0, bytesRead));
			if (fromHeader) return fromHeader;
		} finally {
			await handle.close();
		}
	}
	// Another format: as long as its words, and a breath more.
	return words?.length ? Math.max(...words.map(({ end }) => end)) + 0.2 : null;
}

/** Reads the script, plan and voice takes under `filesRoot`, writes the draft file and, if asked, submits it. */
export async function assembleCommand(input: AssembleInput, filesRoot: string, workspace: string, signal?: AbortSignal) {
	const root = await fs.realpath(filesRoot);
	const lines = parseScript(await fs.readFile(await readInside(root, input.script, "The script"), "utf8"));
	if (!lines.length) throw new Error("The script has no lines like \"A01. Text of the line\".");
	const plan: AssemblePlan = input.plan ? JSON.parse(await fs.readFile(await readInside(root, input.plan, "The plan"), "utf8")) : {};
	if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("The plan must be a JSON object keyed by line code.");

	const voices = new Map<string, LineVoice>();
	const folder = input.voices ?? "voice";
	for (const { code } of lines) {
		const given = plan[code]?.voice;
		let file: string | null = null;
		if (given?.path) file = await readInside(root, given.path, `The voice of ${code}`);
		else for (const extension of VOICE_EXTENSIONS) {
			file = await fileInside(root, folder, `${code}${extension}`);
			if (file) break;
		}
		if (!file) continue;
		const words = await readWords(file);
		const whole = await fileDuration(file, words);
		const start = given?.start ?? 0;
		const end = given?.end ?? whole;
		if (end === null || !(end > start)) continue;
		voices.set(code, { path: relative(root, file), duration: end - start, start, words });
	}

	const result = assembleDraft({ lines, voices, plan, options: { gap: input.gap, start: input.start, captionPreset: input.captionPreset } });
	const title = (input.name ?? path.basename(input.script).replace(/\.[^.]+$/, "")).trim().slice(0, 80) || "draft";
	const name = title.replace(/[^\w.-]+/g, "-");
	const label = `Assemble ${title}`;
	const draft = { schema: "opencut-agent-draft-1", rev: `assemble-${randomUUID().slice(0, 8)}`, label, atomic: true,
		...(input.submit && { projectId: input.submit.projectId }), ops: result.ops };
	const out = path.join(workspace, "assemble", `${name}.draft.json`);
	await atomicWrite(out, JSON.stringify(draft, null, 1), signal);

	const summary = {
		file: relative(workspace, out), lines: lines.length, voiced: voices.size,
		placeholders: result.placed.filter(({ visual }) => visual === "placeholder").map(({ code }) => code),
		missing: result.missing, duration: result.duration, ops: result.ops.length,
	};
	if (!input.submit) return summary;
	const response = await fetch(new URL("/api/mcp", input.submit.origin), {
		method: "POST", headers: { "Content-Type": "application/json" }, signal, redirect: "error",
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
			params: { name: "submit_draft", arguments: { projectId: input.submit.projectId, label, atomic: true, ops: result.ops } } }),
	});
	const answer = await response.json().catch(() => null);
	const submitted = answer?.result?.structuredContent ?? { error: answer?.error?.message ?? answer?.result?.content?.[0]?.text ?? `HTTP ${response.status}` };
	return { ...summary, submitted };
}
