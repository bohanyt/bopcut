import { createCanvas } from "@napi-rs/canvas";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withToolScratch } from "@/retrieval/process";
import { atomicWrite, readJson } from "@/services/storage/server/files";
import { calculateTotalDuration } from "@/timeline";
import { getEffectiveRateAt } from "@/retime/resolve";
import { TICKS_PER_SECOND } from "@/wasm";
import { fileInside, inside } from "./inside";
import { knownExportProfile } from "./export-profile";
import { timelineTranscript } from "./packed-transcript";
import { accumulatePeaks, drawRangeView, RANGE_BUCKETS, RANGE_HEADER, RANGE_ROW_HEIGHT, RANGE_WIDTH } from "./range-view";
import { finding, REVIEW_LIMITS as L, summarizeReview, type ReviewFinding } from "./review-findings";
import { inspectAudio, probeReviewFile, REVIEW_HEIGHT, REVIEW_WIDTH, scanReviewFile, sourceMotion, type FileScan } from "./review-scan";
import { inspectTimeline, type ReviewMedia } from "./review-timeline";
import { readReviewableProject } from "./transcript-view-server";

const missingTool = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const sampleRate = 8000;
const frameBytes = REVIEW_WIDTH * REVIEW_HEIGHT;

type EvidenceRow = { at: number; elementIds: string[]; picture?: string; before?: number; after?: number };
export async function writeReview({
	projectId, relative, pictures, timeoutMs, workspace, filesRoot, signal,
}: {
	projectId: string; relative: string; pictures: boolean; timeoutMs: number;
	workspace: string; filesRoot: string; signal: AbortSignal;
}) {
	relative = path.relative(filesRoot, inside(filesRoot, relative));
	const file = await fileInside(filesRoot, relative);
	if (!file) throw new Error("The export was not found under AGENT_FILES_ROOT.");
	const start = performance.now();
	const active = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
	const { project, projectFile, scenes, root, media, dir } = await readReviewableProject(projectId, active);
	if (!root) throw new Error("No timeline was saved for this project.");
	const duration = calculateTotalDuration({ tracks: root.tracks }) / TICKS_PER_SECOND;
	const { canvasSize, fps = { numerator: 30, denominator: 1 } } = project.settings;
	if (!canvasSize?.width || !canvasSize.height || !(fps.numerator > 0 && fps.denominator > 0)) throw new Error("The saved export settings are incomplete.");
	const assets: ReviewMedia[] = [];
	for (const asset of media) {
		active.throwIfAborted();
		const sourceFile = asset.diskFile && /^[-\w]+\.[a-z0-9]{1,10}$/i.test(asset.diskFile) &&
			path.parse(asset.diskFile).name === asset.id && await fileInside(dir, "media", asset.diskFile);
		assets.push({ ...asset, present: !!sourceFile, sourceFile: sourceFile || undefined });
	}
	for (const scene of scenes) {
		for (const track of [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]) for (const item of track.elements) {
			item.params ??= {};
			if ("mediaId" in item && !assets.some((asset) => asset.id === item.mediaId)) {
				assets.push({ id: item.mediaId, name: item.name, present: false });
			}
		}
	}
	const timeline = inspectTimeline(root, scenes, assets, canvasSize, duration, fps.numerator / fps.denominator);
	const findings = timeline.findings;
	const cuts: EvidenceRow[] = timeline.cuts;
	const skipped: string[] = [];
	const [saved, exported] = await Promise.all([fs.stat(projectFile), fs.stat(file)]);
	const stale = saved.mtimeMs > exported.mtimeMs + 1;
	if (stale) findings.unshift(finding("stale-export", "info", 0, duration, {
		message: "The project was saved after this file was exported. All other findings may be off.",
		savedAt: saved.mtimeMs, fileAt: exported.mtimeMs,
	}));
	const exportResult = await fileInside(workspace, "export-result.json");
	const recorded = exportResult ? await readJson(exportResult).catch(() => null) : null;
	const profile = await knownExportProfile(workspace, projectId, file, exported) ?? (recorded?.status === "done" && recorded.projectId === projectId && recorded.bytes === exported.size &&
		typeof recorded.file === "string" && await fileInside(workspace, recorded.file) === file ? {
			width: typeof recorded.width === "number" ? recorded.width : null,
			height: typeof recorded.height === "number" ? recorded.height : null,
			fps: typeof recorded.fps === "number" ? recorded.fps : null,
		} : null);
	const groups: string[] = [];
	const toolsSkipped = ["file-integrity", "frame-count", "black", "freeze", "loudness", "true-peak", "edge-silence", "cut-click", "pictures"];
	let observed: Record<string, number | string | boolean | null> | null = null;
	let scanSeconds = 0, pictureSeconds = 0, omittedPictures = 0;
	const reviewId = `review-${randomUUID()}`;
	const run = async (scratch: string, cancellation: AbortSignal) => {
		let scan: FileScan;
		try {
			const probe = await probeReviewFile(file, cancellation, filesRoot);
			const beginScan = performance.now();
			scan = await scanReviewFile(file, scratch, probe, cancellation, filesRoot);
			scanSeconds = (performance.now() - beginScan) / 1000;
		} catch (error) {
			cancellation.throwIfAborted();
			if (missingTool(error)) {
				skipped.push(...toolsSkipped);
				return;
			}
			findings.push(finding("broken-file", "error", 0, 0, { message: error instanceof Error ? error.message : String(error) }));
			skipped.push(...toolsSkipped.slice(1));
			return;
		}
		const probe = scan.probe;
		observed = { ...probe, frames: scan.frames };
		if (scan.decodeError || !scan.frames) findings.push(finding("broken-file", "error", scan.frames / probe.fps, probe.duration,
			{ message: scan.decodeError ?? "No frames decoded.", frames: scan.frames }));
		const expectedFrames = Math.ceil(duration * (profile?.fps ?? probe.fps) - 1e-7);
		if (!stale && !scan.decodeError && (Math.abs(probe.duration - duration) > Math.max(0.05, 1 / probe.fps + 0.005) ||
			(!probe.variable && scan.frames !== expectedFrames))) findings.push(finding("timeline-length", "warning", 0, probe.duration,
				{ timelineSeconds: duration, fileSeconds: probe.duration, frames: scan.frames, expectedFrames }));
		if (!stale && profile && ((profile.width && profile.width !== probe.width) || (profile.height && profile.height !== probe.height) ||
			(profile.fps && Math.abs(profile.fps - probe.fps) > 0.01))) findings.push(finding("export-profile", "warning", 0, probe.duration,
				{ width: probe.width, height: probe.height, fps: probe.fps, expectedWidth: profile.width, expectedHeight: profile.height, expectedFps: profile.fps }));
		if (probe.variable) skipped.push("precise-frame-alignment", "black", "freeze", "cut-pictures");
		if (!probe.channels) skipped.push("loudness", "true-peak", "edge-silence", "cut-click");
		else findings.push(...await inspectAudio(scan, cuts, cancellation));
		const visual = timeline.instances.filter(({ element }) => element.type !== "audio" && element.type !== "effect" && element.type !== "compound");
		if (!probe.variable) for (const interval of scan.black) {
			// Sparse type on a black title card can cover less than the pixel threshold on purpose.
			const visible = visual.filter((item) => (item.element.type === "video" || item.element.type === "image") &&
				item.start < interval.to && item.end > interval.from);
			const covered = visible.reduce((maximum, item) => Math.max(maximum, Math.min(interval.to, item.end) - Math.max(interval.from, item.start)), 0);
			if (covered + 1e-8 >= L.blackSeconds) findings.push(finding("black-picture", "error", interval.from, interval.to,
				{ fraction: interval.value, minimumSeconds: L.blackSeconds, threshold: L.blackFraction }, [...new Set(visible.map((item) => item.element.id))]));
		}
		if (!probe.variable) for (const [index, interval] of scan.frozen.entries()) {
			cancellation.throwIfAborted();
			const layers = visual.filter((item) => item.start < interval.to && item.end > interval.from);
			const item = layers[0];
			const source = item?.element;
			const asset = source?.type === "video" ? assets.find(({ id }) => id === source.mediaId) : undefined;
			let movement: number | null = null;
			if (source?.type === "video" && source.retime?.rate !== 0 && item.start <= interval.from + 1 / probe.fps &&
				item.end >= interval.to - 1 / probe.fps && asset?.sourceFile && !stale) {
				const rate = getEffectiveRateAt({ retime: source.retime });
				const shift = item.chain.reduce((sum, parent) => sum + (parent.startTime - parent.trimStart) / TICKS_PER_SECOND, 0);
				const from = source.trimStart / TICKS_PER_SECOND + Math.max(0, interval.from - shift - source.startTime / TICKS_PER_SECOND) * rate;
				const span = Math.min(6, interval.to - interval.from) * rate;
				movement = await sourceMotion(asset.sourceFile, from, from + span, path.join(scratch, `motion-${index}.gray`), cancellation, filesRoot)
					.catch(() => { cancellation.throwIfAborted(); return null; });
			}
			findings.push(finding("frozen-picture", movement !== null && movement >= L.sourceMeanDelta ? "warning" : "info",
				interval.from, interval.to, { exportMeanDelta: interval.value, sourceMeanDelta: movement, motionThreshold: L.sourceMeanDelta,
					minimumSeconds: L.freezeSeconds }, source ? [source.id] : []));
		}
		if (scan.frames && !probe.variable) for (const cut of cuts) {
			const at = Math.max(1, Math.min(scan.frames - 1, Math.ceil(cut.at * probe.fps - 1e-8)));
			cut.before = (at - 1) / probe.fps;
			cut.after = at / probe.fps;
		}
		if (!pictures) skipped.push("pictures-disabled");
		else if (scan.frames && !probe.variable) {
			const beginPictures = performance.now();
			const words = timelineTranscript(root, scenes, assets, { groupWords: false }).flatMap((clip) => clip.phrases);
			omittedPictures = await evidencePictures(scan, workspace, reviewId, words, cuts, findings, groups, cancellation);
			pictureSeconds = (performance.now() - beginPictures) / 1000;
		}
	};
	await withToolScratch(active, filesRoot, run, workspace);
	active.throwIfAborted();
	const report = { version: 1, projectId, file: relative, stale, expected: { timelineDuration: duration, profile }, observed,
		findings, cuts, pictures: groups, omittedPictureRows: omittedPictures, skipped,
		timing: { totalSeconds: (performance.now() - start) / 1000, scanSeconds, pictureSeconds } };
	await atomicWrite(path.join(workspace, "review.json"), JSON.stringify(report, null, 2) + "\n", active);
	return { ...summarizeReview("review.json", findings, skipped), ...(skipped.includes("file-integrity") ?
		{ message: "FFmpeg and FFprobe are required for file checks. Only the saved timeline was checked." } : {}) };
}

async function evidencePictures(scan: FileScan, workspace: string, id: string, words: Parameters<typeof drawRangeView>[2]["words"],
	cuts: EvidenceRow[], findings: ReviewFinding[], files: string[], signal: AbortSignal) {
	const rows = new Map<number, { cuts: EvidenceRow[]; findings: ReviewFinding[] }>();
	const add = (at: number) => {
		const row = rows.get(at) ?? { cuts: [], findings: [] };
		rows.set(at, row);
		return row;
	};
	for (const cut of cuts) add(cut.at).cuts.push(cut);
	for (const hit of findings) if (hit.severity !== "info" || hit.kind === "unusual-pause") {
		add(typeof hit.values.sampledAt === "number" ? hit.values.sampledAt : hit.from).findings.push(hit);
	}
	if (!rows.size) return 0;
	const folder = path.join(workspace, "reviews");
	await fs.mkdir(folder, { recursive: true });
	if (!(await fs.lstat(folder)).isDirectory()) throw new Error("The reviews folder must be a directory.");
	await fs.mkdir(path.join(folder, id));
	const handles = await Promise.all([fs.open(scan.video, "r"), scan.audio ? fs.open(scan.audio, "r").catch(() => null) : null]);
	const [video, audio] = handles;
	try {
		const all = [...rows].sort(([a], [b]) => a - b);
		const pageSize = Math.min(64, Math.max(8, Math.ceil(all.length / 12)));
		for (let offset = 0; offset < all.length && files.length < 12; offset += pageSize) {
			signal.throwIfAborted();
			const page = all.slice(offset, offset + pageSize);
			const intervals = page.map(([time]) => ({ from: Math.max(0, Math.min(scan.probe.duration - 0.1, time - 0.5)),
				to: Math.min(scan.probe.duration, Math.max(0.1, time + 0.5)), time }));
			const frames = [];
			const peaks = new Float32Array(page.length * RANGE_BUCKETS);
			const canvas = createCanvas(RANGE_WIDTH, RANGE_HEADER + RANGE_ROW_HEIGHT * page.length);
			const ctx = canvas.getContext("2d");
			const tile = createCanvas(REVIEW_WIDTH * 2, REVIEW_HEIGHT);
			const tmp = tile.getContext("2d");
			for (let i = 0; i < page.length; i++) {
				signal.throwIfAborted();
				const frame = Math.max(0, Math.min(scan.frames - 1, Math.ceil(page[i][0] * scan.probe.fps - 1e-8)));
				const pair = createCanvas(REVIEW_WIDTH * 2, REVIEW_HEIGHT);
				const pairCtx = pair.getContext("2d");
				for (const [slot, index] of [Math.max(0, frame - 1), frame].entries()) {
					const gray = Buffer.alloc(frameBytes);
					await video.read(gray, 0, gray.length, index * frameBytes);
					const image = tmp.createImageData(REVIEW_WIDTH, REVIEW_HEIGHT);
					for (let j = 0; j < gray.length; j++) {
						image.data[j * 4] = image.data[j * 4 + 1] = image.data[j * 4 + 2] = gray[j];
						image.data[j * 4 + 3] = 255;
					}
					pairCtx.putImageData(image, slot * REVIEW_WIDTH, 0);
				}
				for (const hit of page[i][1].findings) {
					const { boundsX: x, boundsY: y, boundsWidth: w, boundsHeight: h, canvasWidth, canvasHeight } = hit.values;
					if (typeof x !== "number" || typeof y !== "number" || typeof w !== "number" || typeof h !== "number" ||
						typeof canvasWidth !== "number" || typeof canvasHeight !== "number") continue;
					pairCtx.save();
					pairCtx.beginPath();
					pairCtx.rect(REVIEW_WIDTH, 0, REVIEW_WIDTH, REVIEW_HEIGHT);
					pairCtx.clip();
					pairCtx.strokeStyle = "#f4bc65";
					pairCtx.lineWidth = 0.6;
					pairCtx.strokeRect(REVIEW_WIDTH + x / canvasWidth * REVIEW_WIDTH, y / canvasHeight * REVIEW_HEIGHT,
						w / canvasWidth * REVIEW_WIDTH, h / canvasHeight * REVIEW_HEIGHT);
					pairCtx.restore();
				}
				frames.push((x: number, y: number, w: number, h: number) => ctx.drawImage(pair, x, y, w, h));
				if (audio) {
					const { from, to } = intervals[i];
					const samples = Math.max(1, Math.ceil((to - from) * sampleRate));
					const pcm = new Float32Array(samples * scan.probe.channels);
					await audio.read(new Uint8Array(pcm.buffer), 0, pcm.byteLength, Math.floor(from * sampleRate) * scan.probe.channels * 4);
					accumulatePeaks(peaks.subarray(i * RANGE_BUCKETS, (i + 1) * RANGE_BUCKETS), pcm, 0, samples, scan.probe.channels);
				}
			}
			const name = `reviews/${id}/page-${files.length + 1}.png`;
			drawRangeView(ctx, { from: intervals[0].from, to: intervals.at(-1)!.to, rows: page.length }, {
				title: "Export review · frame before / frame after", intervals, frames, peaks, words, spans: [],
			});
			await atomicWrite(path.join(workspace, name), await canvas.encode("png"), signal);
			files.push(name);
			for (const [, row] of page) for (const entry of [...row.cuts, ...row.findings]) entry.picture = name;
		}
		return Math.max(0, all.length - pageSize * files.length);
	} finally { await Promise.all(handles.map((handle) => handle?.close())); }
}
