import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileInside } from "../src/agent/inside";
import { parseSourceWords, type SourceWord } from "../src/media/words";
import { Cancelled } from "../src/retrieval/jobs";
import { runProcess, withToolScratch } from "../src/retrieval/process";
import { commandFromSetting, type Runner } from "../src/retrieval/server";
import { atomicWrite, renameWithRetry } from "../src/services/storage/server/files";

export const MAX_VOICE_TEXT = 100_000;
const MAX_VOICE_BYTES = 1024 * 1024 * 1024;
const voiceName = /^[\w-]{1,64}$/;

export type VoiceInput = { name: string; text?: string; textFile?: string; replace: boolean };

/** Duration in seconds of a PCM or float WAV from its header, or null when the bytes are not a readable WAV. */
export function wavDuration(header: Uint8Array, fileSize: number): number | null {
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	const tag = (at: number) => String.fromCharCode(...header.subarray(at, at + 4));
	if (header.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
	let byteRate = 0;
	for (let offset = 12; offset + 8 <= header.length;) {
		const id = tag(offset);
		const size = view.getUint32(offset + 4, true);
		if (id === "fmt " && size >= 16 && offset + 20 <= header.length) byteRate = view.getUint32(offset + 16, true);
		if (id === "data") {
			// Streaming writers leave the size unset; the rest of the file is then the audio.
			const available = fileSize - offset - 8;
			const bytes = size === 0 || size === 0xffffffff || size > available ? available : size;
			return byteRate > 0 && bytes > 0 ? bytes / byteRate : null;
		}
		offset += 8 + size + (size % 2);
	}
	return null;
}

function relativeOut(root: string, file: string) {
	return path.relative(root, file).split(path.sep).join("/");
}

/** `AGENT_FILES_ROOT/voice`, created when missing; a link that leads elsewhere is refused. */
async function voiceFolder(filesRoot: string) {
	const base = await fs.realpath(filesRoot);
	const folder = path.join(base, "voice");
	await fs.mkdir(folder, { recursive: true });
	if (path.relative(base, await fs.realpath(folder)) !== "voice") {
		throw new Error("AGENT_FILES_ROOT/voice must be a folder inside AGENT_FILES_ROOT, not a link.");
	}
	return { base, folder };
}

/**
 * Speaks a text with the configured text-to-speech command (BOPENCUT_TTS) and saves
 * `voice/<name>.wav`, plus `voice/<name>.wav.words.json` when the command reports word times.
 * The command is called as `<BOPENCUT_TTS> --text-file IN --out OUT.wav --words OUT.json`.
 */
export async function voiceCommand(input: VoiceInput, filesRoot: string, signal: AbortSignal,
	setting = process.env.BOPENCUT_TTS, runner: Runner = runProcess) {
	if (!voiceName.test(input.name)) throw new Error("Pass --name with 1-64 letters, digits, - or _.");
	const tool = setting?.trim() ? commandFromSetting(setting, "") : [];
	if (!tool[0]) throw new Error("Set BOPENCUT_TTS to a text-to-speech command first (see AGENT.md, voice).");
	let text = input.text;
	if (input.textFile !== undefined) {
		const file = await fileInside(filesRoot, input.textFile);
		if (!file) throw new Error(`No text file at ${input.textFile} under AGENT_FILES_ROOT.`);
		text = await fs.readFile(file, "utf8");
	}
	text = text?.trim();
	if (!text) throw new Error("Pass the words to speak with --text or --text-file.");
	if (text.length > MAX_VOICE_TEXT) throw new Error(`The text is longer than ${MAX_VOICE_TEXT} characters. Split it into parts.`);
	const { base, folder } = await voiceFolder(filesRoot);
	const target = path.join(folder, `${input.name}.wav`);
	const sidecar = `${target}.words.json`;
	if (!input.replace && await fs.lstat(target).then(() => true, () => false)) {
		throw new Error(`voice/${input.name}.wav already exists. Pass --replace to make it again, or choose another --name.`);
	}

	return withToolScratch(signal, filesRoot, async (scratch, active) => {
		const textFile = path.join(scratch, "text.txt");
		const out = path.join(scratch, "voice.wav");
		const wordsFile = path.join(scratch, "words.json");
		await fs.writeFile(textFile, text, "utf8");
		try {
			await runner(tool[0], [...tool.slice(1), "--text-file", textFile, "--out", out, "--words", wordsFile], active, filesRoot);
		} catch (error) {
			if (error instanceof Cancelled || active.aborted) throw error;
			const e = error as NodeJS.ErrnoException & { stderr?: string };
			if (e.code === "ENOENT") throw new Error(`The text-to-speech command was not found: ${tool[0]}. Check BOPENCUT_TTS.`);
			const lines = (e.stderr || e.message || "").trim().split(/\r?\n/).filter((line) => line.trim());
			throw new Error(`The text-to-speech command failed: ${lines.slice(-3).join(" ") || "no message"}`);
		}
		const stat = await fs.stat(out).catch(() => null);
		if (!stat?.isFile() || stat.size === 0) throw new Error("The text-to-speech command finished without writing the WAV file given to --out.");
		if (stat.size > MAX_VOICE_BYTES) throw new Error("The text-to-speech output is larger than 1 GB.");
		const handle = await fs.open(out, "r");
		const header = new Uint8Array(Math.min(stat.size, 1024 * 1024));
		try {
			await handle.read(header, 0, header.length, 0);
		} finally {
			await handle.close();
		}
		const duration = wavDuration(header, stat.size);
		if (duration === null) throw new Error("The text-to-speech output is not a WAV file. Make the command write WAV to --out.");

		const warnings: string[] = [];
		let words: SourceWord[] | null = null;
		const reported = await fs.readFile(wordsFile, "utf8").catch(() => null);
		if (reported !== null) {
			try {
				words = parseSourceWords(JSON.parse(reported));
			} catch {
				words = null;
			}
			if (!words) warnings.push("Ignored the words file: it must be a JSON array of {text, start, end} in seconds.");
			else if (words.some((word) => word.end > duration + 0.5)) {
				warnings.push("Some word times end after the audio. Check the command's word timing.");
			}
		}

		// Into the files root only now, so a failed or cancelled run leaves the previous take in place.
		const staged = `${target}.${randomUUID()}.tmp`;
		try {
			await fs.copyFile(out, staged);
			await renameWithRetry(staged, target, active);
		} finally {
			await fs.rm(staged, { force: true });
		}
		if (words) await atomicWrite(sidecar, JSON.stringify(words), active);
		else await fs.rm(sidecar, { force: true });

		const relative = relativeOut(base, target);
		return {
			path: relative,
			duration: Math.round(duration * 1000) / 1000,
			wordsFile: words ? relativeOut(base, sidecar) : null,
			...(warnings.length && { warnings }),
			asset: { path: relative, type: "audio" as const, name: input.name, ...(words && { words }) },
		};
	});
}
