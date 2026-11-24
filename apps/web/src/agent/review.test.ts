import { expect, spyOn, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { fileProbeCommand, toolsFromEnv } from "@/retrieval/server";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { audio, fixture, scene, t, text } from "@/timeline/__tests__/compound-fixtures";
import type { TextElement, VideoElement } from "@/timeline";
import { reserveEditorActivity, reserveReview } from "./review-activity";
import { knownExportProfile, saveExportProfile } from "./export-profile";
import { RANGE_FRAME_WIDTH, RANGE_HEADER, RANGE_ROW_HEIGHT } from "./range-view";
import { cutPop, finding, summarizeReview, unusualPauses } from "./review-findings";
import { inspectTimeline, reviewSourceCrop, textFindings } from "./review-timeline";
import { writeReview } from "./review-server";
import { cutFrames, frameAt, frameCadence, probeReviewFile, scanReviewFile } from "./review-scan";
import { requireReviewScratch, reviewScratchBytes, reviewTimeout } from "./review-limits";
import { visibleRangeElements } from "./range-view-project";

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

test("a short final sample preserves 30 fps, and VFR lookup uses decoded timestamps", () => {
	const stamps = Array.from({ length: 30 }, (_, i) => ({ at: i / 30, duration: i === 29 ? 1 / 60 : 1 / 30 }));
	const cadence = frameCadence(stamps, 30);
	expect(cadence).toMatchObject({ fps: 30, variable: false });
	expect(cadence.videoDuration).toBeCloseTo(59 / 60, 9);
	expect(frameCadence(stamps.map((stamp) => ({ ...stamp, at: stamp.at + 0.021 })), 30).videoDuration).toBeCloseTo(59 / 60, 9);
	expect(frameCadence([...stamps.slice(0, -1), { at: 28 / 30 + 1 / 60, duration: 1 / 60 }], 30).variable).toBe(false);
	const variable = [0, 0.033, 0.1, 0.133, 0.2, 0.233].map((at) => ({ at, duration: 0.033 }));
	expect(frameCadence(variable, 30).variable).toBe(true);
	expect(frameAt(variable, 0.08)).toBe(1);
	expect(frameAt(variable, 0.10)).toBe(2);
	expect(cutFrames(variable, 0.08)).toEqual({ before: 1, after: 2 });
	expect(cutFrames(variable, 0.10)).toEqual({ before: 1, after: 2 });
	expect(cutFrames(variable, 0.25)).toEqual({ before: 5, after: undefined });
});

test("duration controls time and scratch limits before a decode begins", () => {
	expect(reviewTimeout(10)).toBe(180000);
	expect(reviewTimeout(600)).toBe(300000);
	const bytes = reviewScratchBytes(600, 30, 48000, 2);
	expect(bytes).toBe(274176000);
	expect(() => requireReviewScratch(2 * 1024 ** 3 + bytes - 1, bytes)).toThrow("Insufficient scratch space");
	expect(() => requireReviewScratch(2 * 1024 ** 3 + bytes, bytes)).not.toThrow();
});

test("a non-zero export range clips title timing before length and bounds checks", () => {
	const [root] = fixture();
	root.tracks.overlay = [{ type: "text", id: "titles", name: "Titles", hidden: false, elements: [
		{ ...text("headline", 0, 8), params: { content: "Read this full sentence before it disappears", fontSize: 9 } },
		{ ...text("excluded", 0, 0.25), params: { content: "Outside the export", fontSize: 1 } },
	] }];
	root.tracks.audio = [];
	const report = inspectTimeline(root, [root], [], { width: 640, height: 360 }, 10, 30, { from: 5, to: 6 });
	expect(report.findings.find((hit) => hit.kind === "short-text")).toMatchObject({ from: 5, to: 6, elementIds: ["headline"],
		values: { seconds: 1, sampledAt: expect.any(Number) } });
	expect(report.findings.some((hit) => hit.elementIds.includes("excluded"))).toBe(false);
	expect(report.instances.every((item) => item.start >= 5 && item.end <= 6)).toBe(true);
});

test("portrait crop uses the visible source rectangle and rejects unproved transforms", () => {
	const [root] = fixture();
	root.tracks.overlay = [];
	root.tracks.audio = [];
	const item = [...visibleRangeElements(root, [root], { from: 0, to: 5, rows: 1 })][0];
	const asset = { id: "asset", name: "Landscape", width: 640, height: 360 };
	item.element.params = { "transform.scaleX": 3.160493827, "transform.scaleY": 3.160493827 };
	const crop = reviewSourceCrop(item, { width: 360, height: 640 }, asset);
	expect(crop?.x).toBeCloseTo(219, 0);
	expect(crop?.width).toBeGreaterThanOrEqual(202);
	expect(crop?.width).toBeLessThan(205);
	item.element.params["transform.rotate"] = 5;
	expect(reviewSourceCrop(item, { width: 360, height: 640 }, asset)).toBeNull();
});

test("a short caption follows words heard during the span even if the middle of its clip is silent", () => {
	const [root] = fixture();
	root.tracks.main.elements = [];
	const voiced = audio("voice", 0, 10);
	voiced.params = { volume: -60 };
	voiced.animations = {
		volume: { keys: [0, 1, 2].map((time) => ({ id: String(time), time: t(time), value: time === 2 ? -60 : 0,
			segmentToNext: "linear", tangentMode: "auto" })) },
	};
	root.tracks.audio[0].elements = [voiced];
	root.tracks.overlay = [{ type: "text", id: "captions", name: "Captions", hidden: false, elements: [
		{ ...text("cap", 0.2, 0.25), params: { content: "hello", fontSize: 9 } },
	] }];
	const report = inspectTimeline(root, [root], [{ id: "media-voice", name: "Voice",
		words: [{ text: "hello", start: 0.2, end: 0.4 }] }], { width: 640, height: 360 }, 10, 30);
	expect(report.words).toHaveLength(1);
	expect(report.findings.map((hit) => hit.kind)).not.toContain("short-text");
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

test("a nested cut reports the selected root time and the actual clip ID", () => {
	const [root] = fixture();
	root.tracks.overlay = [];
	root.tracks.audio = [];
	root.tracks.main.elements = [{ ...root.tracks.main.elements[0], type: "compound", id: "parent",
		sceneId: "nested", startTime: t(10), trimStart: t(1.5), duration: t(2) }];
	const child = audio("child", 1, 3);
	const nested = scene("nested", { overlay: [], main: { ...root.tracks.main, elements: [] }, audio: [
		{ id: "voice", name: "Voice", type: "audio", muted: false, elements: [child] },
	] }, { kind: "compound" });
	const report = inspectTimeline(root, [root, nested], [{ id: "media-child", name: "Voice",
		words: [{ text: "word", start: 0.3, end: 0.8 }] }], { width: 640, height: 360 }, 12, 30);
	expect(report.findings.find((hit) => hit.kind === "cut-word")).toMatchObject({
		from: 10, severity: "warning", elementIds: ["child"], values: { instance: "parent/child" },
	});
});

test("an export profile belongs to the file that was originally published", async () => {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-profile-"));
	try {
		await fs.mkdir(path.join(workspace, "exports"));
		const file = path.join(workspace, "exports", "example.mp4");
		await fs.writeFile(file, "sample");
		await saveExportProfile(workspace, "exports/example.mp4", { projectId: "fixture", width: 1920, height: 1080, fps: 30,
			sceneId: "second", includeAudio: false, range: { from: 4, to: 8 } });
		const stat = await fs.stat(file);
		expect(await knownExportProfile(workspace, "fixture", file, stat)).toEqual({ width: 1920, height: 1080, fps: 30,
			sceneId: "second", includeAudio: false, range: { from: 4, to: 8 } });
		expect(await knownExportProfile(workspace, "different", file, stat)).toBeNull();
		expect(await knownExportProfile(workspace, "fixture", file, { ...stat, mtimeMs: stat.mtimeMs + 1000 })).toBeNull();
	} finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

const [ffmpeg, ...defaults] = toolsFromEnv().ffmpeg;
const [ffprobe] = fileProbeCommand(ffmpeg);
const available = [ffmpeg, ffprobe].every((command) => !!Bun.which(command) || existsSync(command));
async function encode(args: string[], output: string, codec = "mpeg4") {
	const proc = Bun.spawn([ffmpeg, ...defaults, "-hide_banner", "-loglevel", "error", "-y", ...args,
		"-c:v", codec, "-threads", "1", output], { stderr: "pipe", stdout: "ignore" });
	const stderr = await new Response(proc.stderr).text();
	if (await proc.exited) throw new Error(stderr);
}

test.skipIf(!available)("one pass retains 29.97, 60 and 33/67 ms decoded cadence", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-cadence-"));
	try {
		for (const [name, rate, variable] of [["fractional.mov", "30000/1001", false], ["fast.mov", "60", false],
			["fractional.webm", "30000/1001", false], ["fast.webm", "60", false], ["vary.webm", "30", true]] as const) {
			const file = path.join(dir, name);
			const output = path.join(dir, "decoded-" + name);
			await fs.mkdir(output);
			await encode(["-f", "lavfi", "-i", `testsrc2=s=64x36:r=${rate}:d=1`, ...(variable ?
				["-vf", "select='not(eq(mod(n,3),2))'", "-fps_mode", "vfr"] : [])], file, name.endsWith(".webm") ? "libvpx-vp9" : "mpeg4");
			const signal = AbortSignal.timeout(12_000);
			const scan = await scanReviewFile(file, output, await probeReviewFile(file, signal, dir), signal, dir);
			expect(scan.decodeError).toBeUndefined();
			expect(scan.stamps.length).toBe(scan.frames);
			expect(scan.variable).toBe(variable);
			if (variable) {
				expect(scan.stamps[frameAt(scan.stamps, 0.08)].at).toBeCloseTo(0.033, 3);
				expect(scan.stamps.some((item, i) => i > 0 && item.at - scan.stamps[i - 1].at > 0.06)).toBe(true);
			} else expect(scan.fps).toBeCloseTo(rate === "60" ? 60 : 30000 / 1001, 3);
		}
		const broken = path.join(dir, "timing-failure");
		await fs.mkdir(path.join(broken, "frames.crc"), { recursive: true });
		const file = path.join(dir, "fast.mov");
		const signal = AbortSignal.timeout(12000);
		const probe = await probeReviewFile(file, signal, dir);
		const open = spyOn(fs, "open");
		try {
			await expect(scanReviewFile(file, broken, probe, signal, dir)).rejects.toThrow();
			expect(open).not.toHaveBeenCalledWith(path.join(broken, "frames.gray"), "r");
		} finally { open.mockRestore(); }
	} finally { await fs.rm(dir, { recursive: true, force: true }); }
}, 30_000);

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
		const slow = path.join(media, "slow.mp4");
		await encode(["-f", "lavfi", "-i", "color=c=gray:s=640x360:r=24:d=3", "-f", "lavfi", "-i", "color=c=white:s=640x360:r=24:d=3",
			"-filter_complex_threads", "1", "-filter_complex", "[0:v][1:v]overlay=x='-w+t*24'"], slow);
		const reframe = path.join(media, "reframe.mp4");
		await encode(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=3", "-vf",
			"negate=enable='between(t,1.7,2.25)',drawbox=x=216:y=0:w=208:h=360:c=gray:t=fill,drawbox=x=216:y=0:w=208:h=360:c=black:t=fill:enable='lt(t,1.25)'"],
			reframe);
		const still = path.join(media, "cover.jpg");
		const image = Bun.spawn([ffmpeg, ...defaults, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
			"-i", "color=c=red:s=640x360", "-frames:v", "1", "-threads", "1", still], { stderr: "pipe", stdout: "ignore" });
		if (await image.exited) throw new Error(await new Response(image.stderr).text());
		const words = [0.2, 0.55, 0.9, 1.25, 2.25, 2.6, 2.95, 5.85, 7.3, 7.65].map((start, i) =>
			({ text: `word${i}`, start, end: start + (i === 7 ? 0.3 : 0.18) }));
		for (const asset of [
			{ id: "source", name: "Source", diskFile: "source.mp4", fileType: "video/mp4", width: 640, height: 360, hasAudio: false },
			{ id: "slow", name: "Slow", diskFile: "slow.mp4", fileType: "video/mp4", width: 640, height: 360, hasAudio: false },
			{ id: "reframe", name: "Landscape", diskFile: "reframe.mp4", fileType: "video/mp4", width: 640, height: 360, hasAudio: false },
			{ id: "cover", name: "Cover", diskFile: "cover.jpg", fileType: "image/jpeg", width: 640, height: 360 },
			{ id: "voice", name: "Voice", diskFile: "voice.wav", fileType: "audio/wav", hasAudio: true, words },
			{ id: "rhythmic", name: "Rhythmic voice", diskFile: "rhythmic.wav", fileType: "audio/wav", hasAudio: true, words },
		]) await fs.writeFile(path.join(media, "_metadata", asset.id + ".json"), JSON.stringify(asset));
		const voice = path.join(media, "voice.wav");
		const wav = Bun.spawn([ffmpeg, ...defaults, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
			"sine=frequency=220:sample_rate=48000:duration=14", voice], { stderr: "pipe", stdout: "ignore" });
		if (await wav.exited) throw new Error(await new Response(wav.stderr).text());
		// The raw voice has peaks in the brief dips between the 100 ms window centers.
		const pulse = "between(mod(t,0.1),0.020,0.030)";
		const rhythmic = Bun.spawn([ffmpeg, ...defaults, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
			`aevalsrc='0.125*sin(2*PI*220*t)*if(between(t,3,4.5),${pulse},1)':s=48000:d=14`,
			path.join(media, "rhythmic.wav")], { stderr: "pipe", stdout: "ignore" });
		if (await rhythmic.exited) throw new Error(await new Response(rhythmic.stderr).text());
		const read = async (name: string) => {
			const summary = await writeReview({ projectId: "fixture", relative: name, pictures: name === "bad.mov" || name === "short.mov", timeoutMs: 45_000,
				workspace: dir, filesRoot: files, signal });
			return { summary, report: await Bun.file(path.join(dir, "review.json")).json() as {
				findings: { kind: string; severity: string; from: number; picture?: string }[]; pictures: string[]; sceneId: string;
				timing: { totalSeconds: number }; observed: { frames: number };
				cuts: { at: number; before: number; after: number; picture: string }[];
			} };
		};
		const caption = (id: string, content: string, start: number, duration: number, params: TextElement["params"] = {}): TextElement =>
			({ ...text(id, start, duration), params: { content, fontFamily: "Arial", fontSize: 9, ...params } });
		const portraitScale = 640 / 202;
		const portraitFill = { "transform.scaleX": portraitScale, "transform.scaleY": portraitScale };
		const centerCrop = "crop=202:360:219:0:exact=1,scale=360:640";
		const portraitCut = 11.98, compoundCut = portraitCut + 3;
		const save = async (bad: boolean, short: boolean) => {
			const [root] = fixture();
			const original = root.tracks.main.elements[0] as VideoElement;
			const movie = { ...original, id: "movie", mediaId: "source", duration: t(12), params: short ? portraitFill : {} };
			const portrait = { ...movie, id: "portrait-reframe", mediaId: "reframe", duration: t(3) };
			const nested = scene("nested", { ...root.tracks, audio: [], overlay: [],
				main: { ...root.tracks.main, elements: [portrait] } }, { kind: "compound" });
			root.tracks.main.elements = short ? [
				{ ...movie, id: "before", duration: t(2) },
				{ ...movie, id: "zoom", startTime: t(2), trimStart: t(2), duration: t(2),
					params: { "transform.scaleX": portraitScale * 1.2, "transform.scaleY": portraitScale * 1.2 } },
				{ ...movie, id: "intentional-freeze", startTime: t(4), trimStart: t(4), duration: t(1.25), retime: { rate: 0 } },
				{ ...movie, id: "after-freeze", startTime: t(5.25), trimStart: t(5.25), duration: t(portraitCut - 5.25) },
				{ ...portrait, startTime: t(portraitCut) },
				{ ...text("zoomed-compound", compoundCut, 3), type: "compound", sceneId: nested.id,
					params: { "transform.scaleX": 0.5, "transform.scaleY": 0.5 } },
			] : bad ? [movie] : [{ ...movie, duration: t(9) }, { ...movie, id: "slow-pan", mediaId: "slow", startTime: t(9), duration: t(3) }];
			const upload = { ...audio("voice-a", 0, 6), sourceType: "upload" as const, mediaId: short ? "rhythmic" : "voice" };
			root.tracks.audio[0].elements = [upload, { ...upload, id: "voice-b", startTime: t(6), trimStart: t(bad ? 6.5 : 6) }];
			if (short) upload.animations = { volume: { keys: Array.from({ length: 15 }, (_, i) =>
				[0.01, 0.018, 0.035, 0.045].map((edge, j) => ({
					id: `dip-${i}-${j}`, time: t(3 + i / 10 + edge), value: j === 1 || j === 2 ? -60 : 0,
					segmentToNext: "linear" as const, tangentMode: "auto" as const,
				}))).flat() } };
			const titles = bad ? [
				caption("unsafe", "Edge", 0, 1, { "transform.positionX": 620 }),
				caption("overlap-a", "First", 1, 1), caption("overlap-b", "Second", 1, 1),
				caption("small", "Tiny", 7, 1, { fontSize: 1.5 }),
				caption("short", "This takes time to read", 8, 0.2),
				caption("obscured", "Covered title", 9, 1),
			] : short ? [
				caption("word-title", "word0", 0.2, 0.25), caption("word-glow", "word0", 0.2, 0.25, { "shadow.opacity": 0.8, "shadow.blur": 6 }),
				caption("next-word", "word1", 0.55, 0.2),
			] : [caption("clean", "Opening title", 0.3, 1.5)];
			root.tracks.overlay = [{ type: "text", id: "titles", name: "Titles", hidden: false, elements: titles }];
			if (bad || short) root.tracks.overlay.unshift({ type: "video", id: "cutaway", name: "Cutaway", hidden: false, muted: true,
				elements: [{ ...text("cover", 9, bad ? 1 : 2), type: "image", mediaId: "cover", params: short ? portraitFill : {} }] });
			const alternate = scene("alternate", { ...root.tracks, audio: [], overlay: [] });
			await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify({ version: CURRENT_PROJECT_VERSION,
				metadata: { id: "fixture", name: "Review fixture" }, currentSceneId: root.id, scenes: short ? [root, alternate, nested] : [root, alternate],
				settings: { canvasSize: short ? { width: 360, height: 640 } : { width: 1280, height: 720 },
					fps: { numerator: 24, denominator: 1 }, background: { type: "color", color: "#000000" } } }));
			return titles;
		};
		for (const mode of ["bad", "clean", "short"] as const) {
			const bad = mode === "bad", short = mode === "short";
			const titles = await save(bad, short);
			const audioExpression = bad ? "if(between(t,5.999,6.001),0.55*sin(2*PI*14000*t),if(between(t,5.97,6.03),0.04,0.45)*sin(2*PI*220*t))"
				: short ? `if(between(t,3,4.5),0.000125*${pulse},if(between(t,6,6.15),0.67,0.50))*sin(2*PI*220*t)` : "0.45*sin(2*PI*220*t)";
			const filters = short ? [
				"[0:v]split[wide][zoom]", `[wide]${centerCrop}[base]`, "[zoom]crop=168:300,scale=360:640[punch]",
				"[base][punch]overlay=enable='gte(t,2)*lt(t,4)',drawbox=c=gray:t=fill:enable='gte(t,4)*lt(t,5.25)'[v0]",
			] : bad ? ["[0:v]drawbox=c=gray:t=fill:enable='between(t,4,5.2)',drawbox=c=black:t=fill:enable='between(t,2,2.6)'[v0]"] :
				["[0:v]trim=end=9,setpts=PTS-STARTPTS[head]", `[${2 + titles.length}:v]setpts=PTS-STARTPTS[pan]`, "[head][pan]concat=n=2:v=1:a=0[v0]"];
			const inputs: string[] = [];
			for (const [i, title] of titles.entries()) {
				const tile = short ? createCanvas(360, 640) : createCanvas(640, 360);
				const ctx = tile.getContext("2d");
				ctx.font = `${Number(title.params.fontSize) * tile.height / 90}px Arial`;
				ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "white";
				if (title.id === "word-glow") { ctx.shadowBlur = 6; ctx.shadowColor = "white"; }
				ctx.fillText(String(title.params.content), tile.width / 2 + Number(title.params["transform.positionX"] ?? 0) / 2, tile.height / 2);
				const png = path.join(dir, `title-${i}.png`);
				await fs.writeFile(png, await tile.encode("png"));
				inputs.push("-i", png);
				filters.push(`[v${i}][${i + 2}:v]overlay=enable='gte(t,${title.startTime / t(1)})*lt(t,${(title.startTime + title.duration) / t(1)})'[v${i + 1}]`);
			}
			if (!bad && !short) inputs.push("-i", slow);
			if (short) {
				inputs.push("-i", reframe);
				filters.push(`[v${titles.length}]drawbox=c=red:t=fill:enable='gte(t,9)*lt(t,11)',setsar=1[edited]`,
					`[${2 + titles.length}:v]${centerCrop},split[reframed][nested]`,
					"[nested]scale=180:320,pad=360:640:90:160:black,setsar=1[zoomed]",
					"[reframed]setsar=1[portrait]", "[edited][portrait][zoomed]concat=n=3:v=1:a=0[out]");
			} else filters.push(`[v${titles.length}]${bad ? "drawbox=c=red:t=fill:enable='gte(t,9)*lt(t,10)'" : "null"}[out]`);
			await encode(["-i", source, "-f", "lavfi", "-i", `aevalsrc='${audioExpression}':s=48000:d=12`,
				...inputs, "-filter_complex_threads", "1", "-filter_complex", filters.join(";"), "-map", "[out]", "-map", "1:a:0", "-r", "24",
				"-c:a", "pcm_s16le"], path.join(files, `${mode}.mov`));
			const { report, summary } = await read(`${mode}.mov`);
			expect(summary.sceneNotice).toContain("current saved scene");
			const actionableFindings = report.findings.filter(({ severity }) => severity !== "info");
			if (bad) {
				expect(actionableFindings.map(({ kind }) => kind).sort()).toEqual(["black-picture", "covered-text", "cut-click", "cut-word", "frozen-picture",
					"short-text", "small-text", "text-at-edge", "text-overlap"]);
				for (const [kind, from] of Object.entries({ "black-picture": 2, "covered-text": 9, "cut-click": 6, "cut-word": 6,
					"frozen-picture": 4, "short-text": 8, "small-text": 7, "text-at-edge": 0, "text-overlap": 1 })) {
					expect(report.findings.find((hit) => hit.kind === kind)?.from).toBeCloseTo(from, 1);
				}
				expect(report.findings.some((hit) => hit.kind === "unusual-pause" && hit.severity === "info" && hit.from > 3 && hit.from < 4)).toBe(true);
				expect(report.cuts.every((cut) => cut.before < cut.after)).toBe(true);
				expect(report.pictures.length).toBeGreaterThan(0);
				expect(report.pictures.length).toBeLessThanOrEqual(12);
			} else {
				expect(actionableFindings.map((finding) => ({ mode, finding }))).toEqual([]);
				if (short) {
					for (const [from, to] of [[12, compoundCut], [15, 18]]) {
						expect(report.findings.find((hit) => hit.kind === "black-picture" && hit.from >= from && hit.from < to)?.severity).toBe("info");
						expect(report.findings.find((hit) => hit.kind === "frozen-picture" && hit.from >= from && hit.from < to)?.severity).toBe("info");
					}
					const cut = report.cuts.find(({ at }) => at === portraitCut)!;
					expect([cut.before, cut.after]).toEqual([11958333 * 1e-6, 12]);
					expect(typeof cut.picture).toBe("string");
					const strip = await loadImage(path.join(dir, cut.picture));
					const image = createCanvas(strip.width, strip.height).getContext("2d");
					image.drawImage(strip, 0, 0);
					const rows = new Set([...report.cuts.filter((other) => other.picture === cut.picture).map(({ at }) => at),
						...report.findings.filter((hit) => hit.picture === cut.picture).map(({ from }) => from)]);
					const y = RANGE_HEADER + RANGE_ROW_HEIGHT * [...rows].filter((at) => at < cut.at).length + 6;
					const tilePeak = (slot: number) => image.getImageData(19 + slot * RANGE_FRAME_WIDTH / 2, y + 3, RANGE_FRAME_WIDTH / 2 - 6, 85)
						.data.reduce((max, value, i) => i % 4 === 0 ? Math.max(max, value) : max, 0);
					expect(tilePeak(0)).toBeGreaterThan(40);
					expect(tilePeak(1)).toBeLessThanOrEqual(16);
				} else expect(report.findings.some((hit) => hit.kind === "frozen-picture" && hit.from >= 9 && hit.severity === "info")).toBe(true);
			}
			expect(summary.clean).toBe(!bad);
			expect(report.observed.frames).toBe(short ? 432 : 288);
		}
		await save(false, false);
		await encode(["-i", source, "-an"], path.join(files, "silent.mov"));
		const noAudio = await read("silent.mov");
		expect(noAudio.report.findings.find((hit) => hit.kind === "missing-audio")?.severity).toBe("error");
		const silentStat = await fs.stat(path.join(files, "silent.mov"));
		await fs.writeFile(path.join(dir, "export-result.json"), JSON.stringify({ projectId: "fixture", file: "files/silent.mov",
			bytes: silentStat.size, fileMtimeMs: silentStat.mtimeMs - 1000, status: "done", sceneId: "alternate", includeAudio: false }));
		expect((await read("silent.mov")).summary.sceneNotice).toContain("current saved scene");
		await saveExportProfile(dir, "files/silent.mov", { projectId: "fixture", width: 640, height: 360, fps: 24,
			sceneId: "alternate", includeAudio: false, range: { from: 0, to: 12 } });
		const off = await read("silent.mov");
		expect(off.report.sceneId).toBe("alternate");
		expect(off.summary.sceneNotice).toBeUndefined();
		expect(off.report.findings.find((hit) => hit.kind === "silent-export")?.severity).toBe("info");
		await encode(["-i", source, "-f", "lavfi", "-i", "aevalsrc='if(between(t,3,5),0,0.4*sin(2*PI*220*t))':s=48000:d=12",
			"-map", "0:v", "-map", "1:a", "-c:a", "pcm_s16le"], path.join(files, "broken-mix.mov"));
		const dropped = await read("broken-mix.mov");
		expect(dropped.report.findings.find((hit) => hit.kind === "unexpected-silence")).toMatchObject({ severity: "warning", from: 3 });
		const savedPath = path.join(projectDir, "project.json");
		const oldProject = await fs.readFile(savedPath, "utf8");
		const ducked = JSON.parse(oldProject) as { scenes: ReturnType<typeof fixture> };
		ducked.scenes[0].tracks.audio[0].elements[0].params.volume = -60;
		await fs.writeFile(savedPath, JSON.stringify(ducked));
		await encode(["-i", source, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=12", "-map", "0:v", "-map", "1:a",
			"-c:a", "pcm_s16le"], path.join(files, "ducked.mov"));
		const silence = (await read("ducked.mov")).report.findings;
		expect(silence.find((hit) => hit.kind === "audio-levels")?.severity).toBe("info");
		expect(silence.filter((hit) => hit.kind === "unexpected-silence")).toEqual([expect.objectContaining({ from: 6, severity: "warning" })]);
		await fs.writeFile(savedPath, oldProject);

		// Black in the source and a separate empty timeline gap stay distinguishable.
		const solid = path.join(media, "source.mp4");
		await encode(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=12",
			"-vf", "drawbox=c=black:t=fill:enable='gte(t,0.5)*lt(t,1)'"], solid);
		const edits = JSON.parse(oldProject) as { scenes: ReturnType<typeof fixture> };
		const track = edits.scenes[0].tracks.main;
		const video = track.elements[0];
		track.elements = [{ ...video, duration: t(2) }, { ...video, id: "remaining", startTime: t(2.5), trimStart: t(2.5), duration: t(9.5) }];
		edits.scenes[0].tracks.overlay = [{ type: "text", id: "split-black", name: "Black interval overlay", hidden: false,
			elements: [caption("split", "Split", 0.55, 0.2)] }];
		await fs.writeFile(savedPath, JSON.stringify(edits));
		await encode(["-i", solid, "-vf", "drawbox=c=black:t=fill:enable='gte(t,2)*lt(t,2.5)'", "-an"], path.join(files, "dark.mov"));
		const black = (await read("dark.mov")).report.findings;
		expect(black.find((hit) => hit.kind === "black-picture" && Math.abs(hit.from - 0.75) < 0.05)?.severity).toBe("info");
		expect(black.some((hit) => hit.kind === "black-picture" && Math.abs(hit.from - 0.5) < 0.05)).toBe(false);
		expect(black.find((hit) => hit.kind === "black-gap" && Math.abs(hit.from - 2) < 0.05)?.severity).toBe("warning");
		await save(false, true);

		const cancel = new AbortController();
		const existing = await fs.readdir(path.join(dir, "reviews"));
		const before = await fs.readFile(path.join(dir, "review.json"), "utf8");
		const rename = fs.rename.bind(fs);
		const abortDuringPublish = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to);
			if (path.basename(String(from)).startsWith(".review-")) cancel.abort(new Error("Cancelled before report publication"));
		});
		try {
			await expect(writeReview({ projectId: "fixture", relative: "short.mov", pictures: true, timeoutMs: 45_000,
				workspace: dir, filesRoot: files, signal: cancel.signal })).rejects.toThrow();
		} finally { abortDuringPublish.mockRestore(); }
		expect(cancel.signal.aborted).toBe(true);
		expect(await fs.readdir(path.join(dir, "reviews"))).toEqual(existing);
		expect(await fs.readFile(path.join(dir, "review.json"), "utf8")).toBe(before);
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
