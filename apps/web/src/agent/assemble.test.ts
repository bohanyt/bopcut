import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDefaultScene } from "@/timeline/scenes";
import type { TimelineElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { assembleDraft, type LineVoice, parseScript, wavDuration } from "./assemble";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { computeAgentDraft } = await import("./draft");
const { assembleCommand } = await import("./assemble-command");

/** A silent 16-bit mono PCM WAV of `seconds` at 8 kHz. */
function wav(seconds: number) {
	const rate = 8000, bytes = Math.round(seconds * rate) * 2;
	const out = new Uint8Array(44 + bytes);
	const view = new DataView(out.buffer);
	const tag = (at: number, text: string) => [...text].forEach((char, i) => { out[at + i] = char.charCodeAt(0); });
	tag(0, "RIFF"); view.setUint32(4, 36 + bytes, true); tag(8, "WAVE");
	tag(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
	view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
	tag(36, "data"); view.setUint32(40, bytes, true);
	return out;
}

const script = "Naskah\n\nA01. Kamu pengen main game ini?\nA02. Ternyata ada caranya.\n# a comment\nA03. Tapi belum ada buktinya.\n";

test("a script's coded lines are read in order, and a repeated code is an error", () => {
	expect(parseScript(script)).toEqual([
		{ code: "A01", text: "Kamu pengen main game ini?" },
		{ code: "A02", text: "Ternyata ada caranya." },
		{ code: "A03", text: "Tapi belum ada buktinya." },
	]);
	expect(parseScript("b12a) lower case code\nC3: colon")).toEqual([{ code: "B12A", text: "lower case code" }, { code: "C3", text: "colon" }]);
	expect(() => parseScript("A01. one\nA01. two")).toThrow("A01");
});

test("a WAV file's length comes from its header", () => {
	expect(wavDuration(wav(1.5))).toBe(1.5);
	expect(wavDuration(new Uint8Array([1, 2, 3]))).toBeNull();
});

test("lines play back to back with their captions; a line without a visual gets a placeholder, one without a voice is left out", () => {
	const voices = new Map<string, LineVoice>([
		["A01", { path: "voice/A01.wav", duration: 2, words: [{ text: "Kamu", start: 0.1, end: 0.4 }, { text: "pengen", start: 0.5, end: 0.9 }] }],
		["A03", { path: "voice/take.wav", duration: 1.5, start: 10, words: [{ text: "before", start: 9, end: 9.5 }, { text: "Tapi", start: 10.2, end: 10.5 }] }],
	]);
	const { ops, placed, missing, duration } = assembleDraft({
		lines: parseScript(script), voices, options: { gap: 0.25, captionPreset: "reveal" },
		plan: { A01: { visual: { kind: "news", asset: { path: "shots/a01.png", type: "image" } } }, A03: { visual: { kind: "footage", note: "a crowd" } } },
	});
	expect(missing).toEqual([{ code: "A02", reason: "no voice take" }]);
	expect(placed).toEqual([
		{ code: "A01", start: 0, duration: 2, visual: "shots/a01.png" },
		{ code: "A03", start: 2.25, duration: 1.5, visual: "placeholder" },
	]);
	expect(duration).toBe(3.75);
	const [vo1, cap1, vis1, vo3, cap3, todo3] = ops as { element: Record<string, any>; track: { name: string } }[];
	expect(vo1.element).toMatchObject({ agent_id: "vo-A01", start: 0, duration: 2, trimStart: 0, asset: { path: "voice/A01.wav", type: "audio" } });
	expect(cap1.element.caption).toEqual({ text: "Kamu pengen", words: [{ text: "Kamu", start: 0.1, end: 0.4 }, { text: "pengen", start: 0.5, end: 0.9 }], preset: "reveal" });
	// The picture covers the gap after its line.
	expect(vis1).toMatchObject({ track: { name: "Main" }, element: { start: 0, duration: 2.25, asset: { path: "shots/a01.png", type: "image" } } });
	// A span of a long take: trimmed to it, its words shifted to the clip.
	expect(vo3.element).toMatchObject({ start: 2.25, duration: 1.5, trimStart: 10 });
	expect(cap3.element.caption.words).toEqual([{ text: "Tapi", start: 0.2, end: 0.5 }]);
	expect(todo3).toMatchObject({ track: { name: "Placeholders" }, element: { duration: 1.5, caption: { text: "[A03 · footage] a crowd" } } });
});

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "assemble-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

test("the command finds each line's take, writes a draft the editor applies, and lists what is missing", async () => {
	await fs.mkdir(path.join(root, "voice"));
	await fs.writeFile(path.join(root, "naskah.txt"), script);
	await fs.writeFile(path.join(root, "voice", "A01.wav"), wav(2));
	await fs.writeFile(path.join(root, "voice", "A01.wav.words.json"), JSON.stringify([{ text: "Kamu", start: 0.1, end: 0.4 }]));
	await fs.writeFile(path.join(root, "voice", "A03.wav"), wav(1.25));
	await fs.writeFile(path.join(root, "plan.json"), JSON.stringify({ A01: { visual: { kind: "news", asset: { path: "shots/a01.png", type: "image" } } } }));
	const summary = await assembleCommand({ script: "naskah.txt", plan: "plan.json", name: "part 1" }, root, root);
	expect(summary).toMatchObject({ file: "assemble/part-1.draft.json", lines: 3, voiced: 2, placeholders: ["A03"],
		missing: [{ code: "A02", reason: "no voice take" }], duration: 3.25, ops: 6 });
	const draft = JSON.parse(await fs.readFile(path.join(root, "assemble", "part-1.draft.json"), "utf8"));
	expect(draft).toMatchObject({ schema: "opencut-agent-draft-1", atomic: true, label: "Assemble part 1" });

	// The ops apply as one draft: voice, captions, the picture and the placeholder land where planned.
	const scene = buildDefaultScene({ name: "Main", isMain: true });
	const media = (e: { asset?: { path?: string; type?: string } }) => e.asset?.path ? {
		id: e.asset.path, type: e.asset.type as "audio", duration: e.asset.path === "voice/A01.wav" ? 2 : 1.25,
		...(e.asset.type === "image" && { width: 1080, height: 1920 }),
	} : undefined;
	const outcome = computeAgentDraft({ scenes: [scene], rootSceneId: scene.id, ops: draft.ops, mediaFor: media as never, atomic: true,
		canvas: { width: 1080, height: 1920 }, fps: { numerator: 30, denominator: 1 }, ripple: false });
	expect(outcome.applied).toBe(true);
	const tracks = outcome.scenes[0].tracks;
	const at = (elements: TimelineElement[]) => elements.map(({ name, startTime, duration }) => [name, startTime / TICKS_PER_SECOND, duration / TICKS_PER_SECOND]);
	expect(at(tracks.audio.find(({ name }) => name === "VO")!.elements)).toEqual([["A01", 0, 2], ["A03", 2, 1.25]]);
	expect(at(tracks.main.elements)).toEqual([["A01 news", 0, 2]]);
	expect(tracks.overlay.map(({ name, elements }) => [name, elements.length])).toEqual(expect.arrayContaining([["Captions", 2], ["Placeholders", 1]]));
});

test("a script or plan outside AGENT_FILES_ROOT is refused", async () => {
	await expect(assembleCommand({ script: "../elsewhere.txt" }, root, root)).rejects.toThrow("AGENT_FILES_ROOT");
});
