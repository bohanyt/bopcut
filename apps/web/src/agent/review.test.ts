import { expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileProbeCommand, toolsFromEnv } from "@/retrieval/server";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { audio, fixture, t, text } from "@/timeline/__tests__/compound-fixtures";
import type { TextElement, VideoElement } from "@/timeline";
import { reserveEditorActivity, reserveReview } from "./review-activity";
import { knownExportProfile, saveExportProfile } from "./export-profile";
import { cutPop, finding, summarizeReview, unusualPauses } from "./review-findings";
import { textFindings } from "./review-timeline";
import { writeReview } from "./review-server";

test("a short isolated click is distinct from a hard speech onset and a longer sound effect", () => {
	const pcm = new Float32Array(400).fill(0.02);
	pcm.fill(0.9, 195, 205);
	expect(cutPop(pcm, 8000, 200)).toMatchObject({ peakDb: expect.any(Number), maximumSeconds: 0.01 });
	pcm.fill(0.65, 200);
	expect(cutPop(pcm, 8000, 200)).toBeNull();
	pcm.fill(0.8, 150, 240);
	expect(cutPop(pcm, 8000, 200)).toBeNull();
});

test("pauses and short speech-following texts stay out of warning counts", () => {
	const spans = [0, 0.4, 0.8, 1.2, 2.4, 2.8, 3.2].map((from) => ({ from, to: from + 0.2 }));
	const pauses = unusualPauses(spans);
	expect(pauses).toEqual([expect.objectContaining({ kind: "unusual-pause", severity: "info", from: 1.4, to: 2.4 })]);
	const samples = [{ at: 0.1, bounds: { x: 20, y: 20, w: 50, h: 50 }, opacity: 1, fontPx: 32 }];
	expect(textFindings(samples, { width: 640, height: 360 }, 0, 0.2, "caption", "Hello", true)).toEqual([]);
	expect(textFindings(samples, { width: 640, height: 360 }, 0, 0.2, "title", "Hello", false)[0].kind).toBe("short-text");
	expect(summarizeReview("review.json", pauses, []).clean).toBe(true);
	const many = Array.from({ length: 100 }, (_, i) => finding(`check-${i}`, "warning", i, i, {}));
	const summary = summarizeReview("review.json", many, []);
	expect(summary.findings).toHaveLength(25);
	expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(4000);
});

test("reviews reserve the renderer and microphone before starting", async () => {
	const stop = new AbortController();
	const recording = reserveEditorActivity(stop.signal);
	expect(recording.ok).toBe(true);
	expect(reserveReview(false)).toBeNull();
	stop.abort();
	const release = reserveReview(false);
	try {
		expect(release).not.toBeNull();
		expect(reserveEditorActivity(new AbortController().signal).status).toBe(409);
		expect(reserveReview(false)).toBeNull();
	} finally { release?.(); }
	expect(reserveReview(true)).toBeNull();
});

test("an export profile belongs to the file that was originally published", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-profile-"));
	try {
		await fs.mkdir(path.join(workspace, "exports"));
		const file = path.join(workspace, "exports", "example.mp4");
		await fs.writeFile(file, "sample");
		await saveExportProfile(workspace, "exports/example.mp4", { projectId: "fixture", width: 1920, height: 1080, fps: 30 });
		const stat = await fs.stat(file);
		expect(await knownExportProfile(workspace, "fixture", file, stat)).toEqual({ width: 1920, height: 1080, fps: 30 });
		expect(await knownExportProfile(workspace, "different", file, stat)).toBeNull();
		expect(await knownExportProfile(workspace, "fixture", file, { ...stat, mtimeMs: stat.mtimeMs + 1000 })).toBeNull();
	} finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

const [ffmpeg, ...defaults] = toolsFromEnv().ffmpeg;
const [ffprobe] = fileProbeCommand(ffmpeg);
const available = [ffmpeg, ffprobe].every((command) => !!Bun.which(command) || existsSync(command));
async function encode(args: string[], output: string) {
	const proc = Bun.spawn([ffmpeg, ...defaults, "-hide_banner", "-loglevel", "error", "-y", ...args,
		"-c:v", "mpeg4", "-threads", "1", output], { stderr: "pipe", stdout: "ignore" });
	const stderr = await new Response(proc.stderr).text();
	if (await proc.exited) throw new Error(stderr);
}

test.skipIf(!available)("the planted export has ten findings and both clean twins have no actionable findings", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "finished-review-"));
	const previous = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = dir;
	const signal = AbortSignal.timeout(60_000);
	try {
		const projectDir = path.join(dir, "projects", "fixture");
		const media = path.join(projectDir, "media");
		const files = path.join(dir, "files");
		await fs.mkdir(path.join(media, "_metadata"), { recursive: true });
		await fs.mkdir(files);
		const source = path.join(media, "source.mp4");
		await encode(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=12",
			"-vf", "negate=enable='between(t,4.5,5.2)'"], source);
		const still = path.join(media, "cover.jpg");
		const image = Bun.spawn([ffmpeg, ...defaults, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
			"-i", "color=c=red:s=640x360", "-frames:v", "1", "-threads", "1", still], { stderr: "pipe", stdout: "ignore" });
		if (await image.exited) throw new Error(await new Response(image.stderr).text());
		const words = [0.2, 0.55, 0.9, 1.25, 2.25, 2.6, 2.95, 5.85, 7.3, 7.65].map((start, i) =>
			({ text: `word${i}`, start, end: start + (i === 7 ? 0.3 : 0.18) }));
		for (const asset of [
			{ id: "source", name: "Source", diskFile: "source.mp4", fileType: "video/mp4", width: 640, height: 360, hasAudio: false },
			{ id: "cover", name: "Cover", diskFile: "cover.jpg", fileType: "image/jpeg", width: 640, height: 360 },
			{ id: "voice", name: "Voice", diskFile: "voice.wav", fileType: "audio/wav", hasAudio: true, words },
		]) await fs.writeFile(path.join(media, "_metadata", asset.id + ".json"), JSON.stringify(asset));
		const voice = path.join(media, "voice.wav");
		const wav = Bun.spawn([ffmpeg, ...defaults, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
			"sine=frequency=220:sample_rate=48000:duration=14", voice], { stderr: "pipe", stdout: "ignore" });
		if (await wav.exited) throw new Error(await new Response(wav.stderr).text());
		const read = async (name: string) => {
			const summary = await writeReview({ projectId: "fixture", relative: name, pictures: name === "bad.mov", timeoutMs: 45_000,
				workspace: dir, filesRoot: files, signal });
			return { summary, report: await Bun.file(path.join(dir, "review.json")).json() as {
				findings: { kind: string; severity: string; from: number; picture?: string }[]; pictures: string[];
				timing: { totalSeconds: number }; observed: { frames: number }; cuts: { before: number; after: number }[];
			} };
		};
		const caption = (id: string, content: string, start: number, duration: number, params: TextElement["params"] = {}): TextElement =>
			({ ...text(id, start, duration), params: { content, fontFamily: "Arial", fontSize: 9, ...params } });
		const save = async (bad: boolean, short: boolean) => {
			const [root] = fixture();
			const original = root.tracks.main.elements[0] as VideoElement;
			const movie = { ...original, id: "movie", mediaId: "source", duration: t(12), params: {} };
			root.tracks.main.elements = short ? [
				{ ...movie, id: "before", duration: t(2) },
				{ ...movie, id: "zoom", startTime: t(2), trimStart: t(2), duration: t(2), params: { "transform.scaleX": 1.2, "transform.scaleY": 1.2 } },
				{ ...movie, id: "intentional-freeze", startTime: t(4), trimStart: t(4), duration: t(1.25), retime: { rate: 0 } },
				{ ...movie, id: "after-freeze", startTime: t(5.25), trimStart: t(5.25), duration: t(6.75) },
			] : [movie];
			const upload = { ...audio("voice-a", 0, 6), sourceType: "upload" as const, mediaId: "voice" };
			root.tracks.audio[0].elements = [upload, { ...upload, id: "voice-b", startTime: t(6), trimStart: t(bad ? 6.5 : 6) }];
			const titles = bad ? [
				caption("unsafe", "Edge", 0, 1, { "transform.positionX": 620 }),
				caption("overlap-a", "First", 1, 1), caption("overlap-b", "Second", 1, 1),
				caption("small", "Tiny", 7, 1, { fontSize: 1.5 }),
				caption("short", "This takes time to read", 8, 0.2),
				caption("obscured", "Covered title", 9, 1),
			] : short ? [
				caption("word-title", "word0", 0.2, 0.25), caption("word-glow", "word0", 0.2, 0.25),
				caption("next-word", "word1", 0.55, 0.2),
			] : [caption("clean", "Opening title", 0.3, 1.5)];
			root.tracks.overlay = [{ type: "text", id: "titles", name: "Titles", hidden: false, elements: titles }];
			if (bad || short) root.tracks.overlay.unshift({ type: "video", id: "cutaway", name: "Cutaway", hidden: false, muted: true,
				elements: [{ ...text("cover", 9, bad ? 1 : 2), type: "image", mediaId: "cover", params: {} }] });
			await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify({ version: CURRENT_PROJECT_VERSION,
				metadata: { id: "fixture", name: "Review fixture" }, currentSceneId: root.id, scenes: [root],
				settings: { canvasSize: { width: 1280, height: 720 }, fps: { numerator: 24, denominator: 1 }, background: { type: "color", color: "#000000" } } }));
		};
		for (const mode of ["bad", "clean", "short"] as const) {
			const bad = mode === "bad", short = mode === "short";
			await save(bad, short);
			const audioExpression = bad ? "if(between(t,5.999,6.001),0.55,if(between(t,5.97,6.03),0.04,0.45)*sin(2*PI*220*t))"
				: short ? "if(between(t,6,6.15),0.67,0.50)*sin(2*PI*220*t)" : "0.45*sin(2*PI*220*t)";
			const video = bad ? ["-vf",
				"drawbox=c=gray:t=fill:enable='between(t,4,5.2)',drawbox=c=black:t=fill:enable='between(t,2,2.6)'"]
				: short ? ["-vf", "drawbox=c=gray:t=fill:enable='gte(t,4)*lt(t,5.25)',drawbox=c=red:t=fill:enable='gte(t,9)*lt(t,11)'"] : [];
			await encode(["-i", source, "-f", "lavfi", "-i", `aevalsrc='${audioExpression}':s=48000:d=12`,
				...video, "-map", "0:v:0", "-map", "1:a:0", "-c:a", "pcm_s16le"], path.join(files, `${mode}.mov`));
			const { report, summary } = await read(`${mode}.mov`);
			const actionable = report.findings.filter(({ severity }) => severity !== "info").map(({ kind }) => kind).sort();
			if (bad) {
				expect(actionable).toEqual(["black-picture", "covered-text", "cut-click", "cut-word", "frozen-picture",
					"short-text", "small-text", "text-at-edge", "text-overlap"]);
				expect(report.findings.some((hit) => hit.kind === "unusual-pause" && hit.severity === "info" && hit.from > 3 && hit.from < 4)).toBe(true);
				expect(report.cuts.every((cut) => cut.before < cut.after)).toBe(true);
				expect(report.pictures.length).toBeGreaterThan(0);
				expect(report.pictures.length).toBeLessThanOrEqual(12);
			} else expect(actionable).toEqual([]);
			expect(summary.clean).toBe(!bad);
			expect(report.observed.frames).toBe(288);
		}
		const oldSetting = process.env.BOPENCUT_FFPROBE;
		try {
			process.env.BOPENCUT_FFPROBE = path.join(dir, "missing-ffprobe");
			const { summary } = await read("short.mov");
			expect(summary.skipped).toEqual(expect.arrayContaining(["file-integrity", "loudness", "cut-click", "pictures"]));
			expect(summary.message).toContain("Only the saved timeline was checked.");
		} finally {
			if (oldSetting === undefined) delete process.env.BOPENCUT_FFPROBE;
			else process.env.BOPENCUT_FFPROBE = oldSetting;
		}
	} finally {
		if (previous === undefined) delete process.env.BOPENCUT_DATA;
		else process.env.BOPENCUT_DATA = previous;
		await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
	}
}, 70_000);
