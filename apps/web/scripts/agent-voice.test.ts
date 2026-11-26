import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "./agent";
import { voiceCommand, wavDuration } from "./agent-voice";

function wav(seconds: number, { sampleRate = 8000, dataSize }: { sampleRate?: number; dataSize?: number } = {}) {
	const bytes = Math.round(seconds * sampleRate) * 2;
	const out = new Uint8Array(44 + bytes);
	const view = new DataView(out.buffer);
	const tag = (at: number, text: string) => [...text].forEach((char, index) => { out[at + index] = char.charCodeAt(0); });
	tag(0, "RIFF"); view.setUint32(4, 36 + bytes, true); tag(8, "WAVE");
	tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
	tag(36, "data"); view.setUint32(40, dataSize ?? bytes, true);
	return out;
}

test("WAV durations come from the header, also when a streaming writer left the size unset", () => {
	expect(wavDuration(wav(0.5), 44 + 8000)).toBe(0.5);
	expect(wavDuration(wav(0.25, { dataSize: 0 }), 44 + 4000)).toBe(0.25);
	expect(wavDuration(new TextEncoder().encode("ID3 not a wav file"), 18)).toBeNull();
});

let root: string;
let tts: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-voice-"));
	// A stand-in for a real voice: one word per spoken word, a quarter second each.
	tts = path.join(root, "..", `${path.basename(root)}-tts.js`);
	await fs.writeFile(tts, `
		const fs = require("node:fs");
		const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
		const text = fs.readFileSync(arg("--text-file"), "utf8");
		if (text === "fail") { console.error("voice model missing"); process.exit(3); }
		if (text === "mp3") { fs.writeFileSync(arg("--out"), "ID3 not a wav"); process.exit(0); }
		const words = text.split(/\\s+/);
		const bytes = words.length * 4000;
		const out = Buffer.alloc(44 + bytes);
		out.write("RIFF", 0); out.writeUInt32LE(36 + bytes, 4); out.write("WAVE", 8); out.write("fmt ", 12);
		out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(8000, 24);
		out.writeUInt32LE(16000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(bytes, 40);
		fs.writeFileSync(arg("--out"), out);
		if (!text.startsWith("nowords")) fs.writeFileSync(arg("--words"), JSON.stringify(words.map((word, i) => ({ text: word, start: i / 4, end: (i + 1) / 4 }))));
	`);
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
	await fs.rm(tts, { force: true });
});

const setting = () => `"${process.execPath}" "${tts}"`;
const speak = (input: Partial<Parameters<typeof voiceCommand>[0]>, configured = setting()) =>
	voiceCommand({ name: "hook", replace: false, ...input }, root, AbortSignal.timeout(20_000), configured);

test("voice saves the WAV and its word times under voice/, ready for a draft asset", async () => {
	const result = await speak({ text: "  Siapa yang menang?  " });
	expect(result).toEqual({
		path: "voice/hook.wav", duration: 0.75, wordsFile: "voice/hook.wav.words.json",
		asset: { path: "voice/hook.wav", type: "audio", name: "hook", words: [
			{ text: "Siapa", start: 0, end: 0.25 }, { text: "yang", start: 0.25, end: 0.5 }, { text: "menang?", start: 0.5, end: 0.75 },
		] },
	});
	expect(wavDuration(new Uint8Array(await fs.readFile(path.join(root, "voice", "hook.wav"))), 44 + 12000)).toBe(0.75);
	expect(JSON.parse(await fs.readFile(path.join(root, "voice", "hook.wav.words.json"), "utf8"))).toEqual(result.asset.words);
	expect((await fs.readdir(path.join(root, "voice"))).sort()).toEqual(["hook.wav", "hook.wav.words.json"]);
});

test("voice keeps an existing take unless --replace, and a replacement without words drops the old word file", async () => {
	await fs.mkdir(path.join(root, "scripts"));
	await fs.writeFile(path.join(root, "scripts", "line.txt"), "Satu dua");
	await speak({ textFile: "scripts/line.txt" });
	await expect(speak({ text: "Tiga" })).rejects.toThrow("voice/hook.wav already exists. Pass --replace");
	const replaced = await speak({ text: "nowords tiga empat", replace: true });
	expect(replaced).toMatchObject({ duration: 0.75, wordsFile: null, asset: { path: "voice/hook.wav", type: "audio", name: "hook" } });
	expect(replaced.asset).not.toHaveProperty("words");
	expect(await fs.readdir(path.join(root, "voice"))).toEqual(["hook.wav"]);
});

test("voice explains a missing setting, a failing command, a non-WAV output and paths outside the files root", async () => {
	await expect(speak({ text: "Halo" }, "")).rejects.toThrow("Set BOPENCUT_TTS");
	await expect(speak({ text: "fail" })).rejects.toThrow("The text-to-speech command failed: voice model missing");
	await expect(speak({ text: "mp3" })).rejects.toThrow("not a WAV file");
	await expect(speak({ text: "Halo" }, `"${path.join(root, "missing-tts")}"`)).rejects.toThrow("not found");
	await expect(speak({ textFile: "../outside.txt" })).rejects.toThrow();
	await expect(speak({ name: "../hook", text: "Halo" })).rejects.toThrow("Pass --name");
	expect(await fs.readdir(path.join(root, "voice")).catch(() => [])).toEqual([]);
});

test("voice takes a name and exactly one text source", () => {
	expect(parseArgs(["voice", "--name", "hook", "--text", "Halo"])).toMatchObject({
		command: "voice", input: { name: "hook", text: "Halo", replace: false }, timeoutMs: 600_000,
	});
	expect(parseArgs(["voice", "--name", "hook", "--text-file", "a.txt", "--replace"])).toMatchObject({ input: { textFile: "a.txt", replace: true } });
	expect(() => parseArgs(["voice", "--name", "hook"])).toThrow("Use voice --name NAME");
	expect(() => parseArgs(["voice", "--name", "hook", "--text", "a", "--text-file", "b"])).toThrow("Use voice --name NAME");
});
