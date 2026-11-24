import { createCanvas } from "@napi-rs/canvas";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withToolScratch } from "@/retrieval/process";
import { atomicWrite, readJson } from "@/services/storage/server/files";
import { calculateTotalDuration } from "@/timeline";
import { getEffectiveRateAt } from "@/retime/resolve";
import { TICKS_PER_SECOND } from "@/wasm";
import { libraryPreviewFile } from "@/sounds/sfx-server";
import { MUSIC_LIBRARY } from "@/sounds/music-server";
import { fileInside, inside } from "./inside";
import { exportSceneSettings, knownExportProfile } from "./export-profile";
import { accumulatePeaks, drawRangeView, RANGE_BUCKETS, RANGE_HEADER, RANGE_ROW_HEIGHT, RANGE_WIDTH } from "./range-view";
import { decibels, finding, meanDelta, REVIEW_LIMITS as L, summarizeReview, type ReviewFinding } from "./review-findings";
import { cutFrames, frameAt, inspectAudio, probeReviewFile, REVIEW_HEIGHT, REVIEW_WIDTH, scanReviewFile, sourceFrames, sourcePeaks, type FileScan, type Interval } from "./review-scan";
import { inspectTimeline, reviewOpacity, reviewSourceCrop, type ReviewMedia } from "./review-timeline";
import { readReviewableProject } from "./transcript-view-server";
import { requireReviewScratch, reviewScratchBytes, reviewTimeout } from "./review-limits";

const missingTool = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const frameBytes = REVIEW_WIDTH * REVIEW_HEIGHT;

type EvidenceRow = { at: number; elementIds: string[]; picture?: string; before?: number; after?: number };
export async function writeReview({
	projectId, relative, pictures, timeoutMs, workspace, filesRoot, signal,
}: {
	projectId: string; relative: string; pictures: boolean; timeoutMs?: number;
	workspace: string; filesRoot: string; signal: AbortSignal;
}) {
	relative = path.relative(filesRoot, inside(filesRoot, relative));
	const file = await fileInside(filesRoot, relative);
	if (!file) throw new Error("The export was not found under AGENT_FILES_ROOT.");
	const start = performance.now();
	let active = timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
	const { project, projectFile, scenes, root: defaultRoot, activeSceneId, media, dir } = await readReviewableProject(projectId, active);
	const [saved, exported] = await Promise.all([fs.stat(projectFile), fs.stat(file)]);
	const exportResult = await fileInside(workspace, "export-result.json");
	const recorded = exportResult ? await readJson(exportResult).catch(() => null) : null;
	const profile = await knownExportProfile(workspace, projectId, file, exported) ?? (recorded?.status === "done" && recorded.projectId === projectId && recorded.bytes === exported.size &&
		recorded.fileMtimeMs === exported.mtimeMs &&
		typeof recorded.file === "string" && await fileInside(workspace, recorded.file) === file ? {
			width: typeof recorded.width === "number" ? recorded.width : null,
			height: typeof recorded.height === "number" ? recorded.height : null,
			fps: typeof recorded.fps === "number" ? recorded.fps : null,
			...exportSceneSettings(recorded),
		} : null);
	const root = profile?.sceneId ? scenes.find((scene) => scene.id === profile.sceneId) : scenes.find((scene) => scene.id === activeSceneId) ?? defaultRoot;
	if (!root) throw new Error("No timeline was saved for this project.");
	const fullDuration = calculateTotalDuration({ tracks: root.tracks }) / TICKS_PER_SECOND;
	const timelineStart = profile?.range?.from ?? 0, timelineEnd = profile?.range?.to ?? fullDuration;
	const duration = timelineEnd - timelineStart;
	const sceneNotice = profile?.sceneId ? undefined : "Export scene unknown. Using the current saved scene.";
	const { canvasSize, fps = { numerator: 30, denominator: 1 } } = project.settings;
	if (!canvasSize?.width || !canvasSize.height || !(fps.numerator > 0 && fps.denominator > 0)) throw new Error("The saved export settings are incomplete.");
	const assets: ReviewMedia[] = [];
	for (const asset of media) {
		active.throwIfAborted();
		const sourceFile = asset.diskFile && /^[-\w]+\.[a-z0-9]{1,10}$/i.test(asset.diskFile) &&
			path.parse(asset.diskFile).name === asset.id && await fileInside(dir, "media", asset.diskFile);
		const type = asset.fileType?.startsWith("video/") ? "video" : asset.fileType?.startsWith("image/") ? "image" : "audio";
		assets.push({ ...asset, type, present: !!sourceFile, sourceFile: sourceFile || undefined });
	}
	for (const scene of scenes) {
		for (const track of [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]) for (const item of track.elements) {
			item.params ??= {};
			if ("mediaId" in item && !assets.some((asset) => asset.id === item.mediaId)) {
				assets.push({ id: item.mediaId, name: item.name, present: false });
			}
		}
	}
	const timeline = inspectTimeline(root, scenes, assets, canvasSize, fullDuration, fps.numerator / fps.denominator, { from: timelineStart, to: timelineEnd });
	const findings = timeline.findings.filter((hit) => hit.from < timelineEnd && hit.to >= timelineStart);
	for (const hit of findings) {
		hit.from = Math.max(0, hit.from - timelineStart);
		hit.to = Math.min(duration, hit.to - timelineStart);
		if (typeof hit.values.sampledAt === "number") hit.values.sampledAt = Math.max(hit.from, Math.min(hit.to, hit.values.sampledAt - timelineStart));
	}
	const cuts: EvidenceRow[] = timeline.cuts.filter((cut) => cut.at > timelineStart && cut.at < timelineEnd)
		.map((cut) => ({ ...cut, at: cut.at - timelineStart }));
	const skipped: string[] = [];
	const stale = saved.mtimeMs > exported.mtimeMs + 1;
	if (stale) findings.unshift(finding("stale-export", "info", 0, duration, {
		message: "The project was saved after this file was exported. All other findings may be off.",
		savedAt: saved.mtimeMs, fileAt: exported.mtimeMs,
	}));
	const groups: string[] = [];
	const toolsSkipped = ["file-integrity", "frame-count", "black", "freeze", "loudness", "true-peak", "edge-silence", "cut-click", "pictures"];
	let observed: Record<string, number | string | boolean | null> | null = null;
	let scanSeconds = 0, pictureSeconds = 0, omittedPictures = 0;
	const reviewId = `review-${randomUUID()}`;
	const staged = path.join(workspace, "reviews", `.${reviewId}`);
	const published = path.join(workspace, "reviews", reviewId);
	let startedPictures = false;
	let promoted = false;
	let committed = false;
	const run = async (scratch: string, cancellation: AbortSignal) => {
		let scan: FileScan;
		let probe: Awaited<ReturnType<typeof probeReviewFile>>;
		const probeSignal = timeoutMs === undefined ?
			AbortSignal.any([cancellation, AbortSignal.timeout(reviewTimeout(0))]) : cancellation;
		try {
			probe = await probeReviewFile(file, probeSignal, filesRoot);
		} catch (error) {
			probeSignal.throwIfAborted();
			if (missingTool(error)) { skipped.push(...toolsSkipped); return; }
			findings.push(finding("broken-file", "error", 0, 0, { message: error instanceof Error ? error.message : String(error) }));
			skipped.push(...toolsSkipped.slice(1));
			return;
		}
		if (timeoutMs === undefined) {
			active = cancellation = AbortSignal.any([cancellation, AbortSignal.timeout(Math.max(1, reviewTimeout(probe.duration) - Math.ceil(performance.now() - start)))]);
		}
		const scratchSpace = await fs.statfs(scratch);
		requireReviewScratch(scratchSpace.bavail * scratchSpace.bsize, reviewScratchBytes(probe.duration, probe.fps, probe.sampleRate, probe.channels));
		try {
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
		observed = { ...probe, fps: scan.fps, frames: scan.frames, videoDuration: scan.videoDuration, variable: scan.variable };
		if (scan.decodeError || !scan.frames) findings.push(finding("broken-file", "error", scan.stamps.at(-1)?.at ?? 0, probe.duration,
			{ message: scan.decodeError ?? "No frames decoded.", frames: scan.frames }));
		const expectedFrames = Math.ceil(duration * (profile?.fps ?? scan.fps) - 1e-4);
		if (!stale && !scan.decodeError && (Math.abs(scan.videoDuration - duration) > 1 / scan.fps + 0.005 ||
			(!scan.variable && scan.frames !== expectedFrames))) findings.push(finding("timeline-length", "warning", 0, scan.videoDuration,
				{ timelineSeconds: duration, fileSeconds: scan.videoDuration, frames: scan.frames, expectedFrames }));
		if (!stale && profile && ((profile.width && profile.width !== probe.width) || (profile.height && profile.height !== probe.height) ||
			(profile.fps && Math.abs(profile.fps - scan.fps) > 0.08))) findings.push(finding("export-profile", "warning", 0, scan.videoDuration,
				{ width: probe.width, height: probe.height, fps: scan.fps, expectedWidth: profile.width, expectedHeight: profile.height, expectedFps: profile.fps }));
		const expectedSounds = profile?.includeAudio === false ? [] : timeline.sounds.filter((item) => item.to > timelineStart && item.from < timelineEnd);
		const silent: Interval[] = [];
		if (!probe.channels) skipped.push("loudness", "true-peak", "edge-silence", "cut-click");
		else findings.push(...await inspectAudio(scan, cuts, cancellation, silent));
		if (!probe.channels) findings.push(finding(expectedSounds.length ? "missing-audio" : "silent-export",
			expectedSounds.length ? "error" : "info", 0, scan.videoDuration, { expected: expectedSounds.length > 0, includeAudio: profile?.includeAudio ?? null },
			[...new Set(expectedSounds.map((sound) => sound.element.id.split("/").at(-1)!))]));
		for (const quiet of silent) {
			const step = 0.1;
			const expected = new Map<number, { peak: number; id: string }>();
			for (const sound of expectedSounds) {
				const origin = quiet.from + timelineStart;
				const first = Math.max(0, Math.ceil((sound.from - origin) / step - 1e-7));
				const last = Math.floor((Math.min(sound.to, quiet.to + timelineStart) - origin) / step + 1e-7);
				if (last <= first) continue;
				let filename = assets.find(({ id }) => id === sound.mediaId)?.sourceFile;
				if (!filename && /^\/api\/agent\/(?:sfx|music)-file\?/.test(sound.mediaId)) {
					const url = new URL(sound.mediaId, "http://localhost");
					filename = await libraryPreviewFile(url.searchParams.get("ref") ?? "", { filesRoot },
						url.pathname.endsWith("/music-file") ? MUSIC_LIBRARY : undefined) ?? undefined;
				}
				if (!filename) continue;
				const sourceStep = step * sound.rate;
				const at = sound.src + (origin + first * step - sound.from) * sound.rate;
				const peaks = await sourcePeaks(filename, at, at + (last - first) * sourceStep, sourceStep, cancellation, filesRoot)
					.catch(() => { cancellation.throwIfAborted(); return []; });
				for (const entry of peaks) {
					const index = first + Math.round(entry.at / sourceStep);
					if (index < first || index >= last) continue;
					const gain = sound.gain(origin + (index + 0.5) * step);
					const peak = entry.peak + decibels(gain);
					if (peak > -45 && peak > (expected.get(index)?.peak ?? -Infinity)) {
						expected.set(index, { peak, id: sound.element.id.split("/").at(-1)! });
					}
				}
			}
			const indices = [...expected.keys()].sort((a, b) => a - b);
			for (let i = 0; i < indices.length;) {
				const start = i++;
				while (i < indices.length && indices[i] === indices[i - 1] + 1) i++;
				if (i - start < 10) continue;
				const group = indices.slice(start, i).map((index) => expected.get(index)!);
				findings.push(finding("unexpected-silence", "warning",
					quiet.from + indices[start] * step, quiet.from + (indices[i - 1] + 1) * step,
					{ exportBelowDb: -60, expectedAboveDb: -45, lowestExpectedPeakDb: Math.min(...group.map((item) => item.peak)), windowSeconds: step },
					[...new Set(group.map((item) => item.id))]));
			}
		}
		const visual = timeline.instances.filter(({ element }) => element.type !== "audio" && element.type !== "compound");
		const sourceTime = (item: typeof visual[number], time: number) => {
			const element = item.element;
			const rate = getEffectiveRateAt({ retime: "retime" in element ? element.retime : undefined });
			const shift = item.chain.reduce((sum, parent) => sum + (parent.startTime - parent.trimStart) / TICKS_PER_SECOND, 0);
			return element.trimStart / TICKS_PER_SECOND + Math.max(0, time + timelineStart - shift - element.startTime / TICKS_PER_SECOND) * rate;
		};
		for (const [index, interval] of scan.black.entries()) {
			const edge = interval.from <= (scan.stamps[0]?.at ?? 0) + 1e-6 || interval.to >= scan.videoEnd - 1e-6;
			const values = { fraction: interval.value, minimumSeconds: L.blackSeconds, threshold: L.blackFraction };
			if (interval.to - interval.from < L.blackSeconds - 1e-6) {
				if (edge) findings.push(finding("black-edge", "info", interval.from, interval.to, values));
				continue;
			}
			const from = interval.from + timelineStart, to = interval.to + timelineStart;
			const visible = visual.filter((item) => item.start < to && item.end > from);
			const boundaries = [...new Set([from, to, ...visible.flatMap((item) => [Math.max(from, item.start), Math.min(to, item.end)])])]
				.sort((a, b) => a - b);
			for (let piece = 1; piece < boundaries.length; piece++) {
				const a = boundaries[piece - 1], b = boundaries[piece];
				if (b - a < L.blackSeconds - 1e-6) continue;
				const midpoint = (a + b) / 2;
				const layers = visible.filter((layer) => layer.start <= midpoint && layer.end > midpoint &&
					reviewOpacity(layer, midpoint, canvasSize.height) > 0);
				const item = layers[0];
				if (!item) {
					if (!visible.some((layer) => layer.start <= midpoint && layer.end > midpoint)) {
						findings.push(finding("black-gap", "warning", a - timelineStart, b - timelineStart, values));
					}
					continue;
				}
				const element = item.element;
				const fade = [a, midpoint, b - 1e-6].some((time) => reviewOpacity(item, time, canvasSize.height) < 0.95);
				if (fade || (element.type !== "image" && element.type !== "video")) continue;
				const asset = assets.find(({ id }) => id === element.mediaId);
				const crop = layers.length === 1 && asset ? reviewSourceCrop(item, canvasSize, asset) : null;
				const times = element.type === "image" ? [0] : [sourceTime(item, midpoint - timelineStart)];
				const frames = crop && asset?.sourceFile && !stale
					? await sourceFrames(asset.sourceFile, times, path.join(scratch, `black-${index}.gray`), cancellation, filesRoot, element.type === "image", crop)
						.catch(() => { cancellation.throwIfAborted(); return []; }) : [];
				const reference = frames[0];
				const blackFraction = reference && crop ? 1 - crop.coverage * reference.reduce((sum, pixel) => sum + Number(pixel > 16), 0) / reference.length : null;
				findings.push(finding("black-picture", blackFraction !== null && blackFraction < L.blackFraction ? "error" : "info",
					a - timelineStart, b - timelineStart, { ...values, sourceBlackFraction: blackFraction }, [element.id]));
			}
		}
		for (const [index, interval] of scan.frozen.entries()) {
			cancellation.throwIfAborted();
			const layers = visual.filter((item) => item.start < interval.to + timelineStart && item.end > interval.from + timelineStart);
			const item = layers[0];
			const source = item?.element;
			const asset = source?.type === "video" ? assets.find(({ id }) => id === source.mediaId) : undefined;
			const crop = layers.length === 1 && asset ? reviewSourceCrop(item, canvasSize, asset) : null;
			let movement: number | null = null;
			if (source?.type === "video" && source.retime?.rate !== 0 && item.start <= interval.from + timelineStart + 1e-6 &&
				item.end >= interval.to + timelineStart - 1e-6 && crop && asset?.sourceFile && !stale &&
				reviewOpacity(item, interval.from + timelineStart, canvasSize.height) >= 0.95) {
				const first = frameAt(scan.stamps, interval.from);
				const last = frameAt(scan.stamps, Math.min(interval.to - 1e-6, interval.from + 6));
				const times = scan.stamps.slice(first, last + 1).map((stamp) => sourceTime(item, stamp.at));
				movement = await sourceFrames(asset.sourceFile, times, path.join(scratch, `motion-${index}.gray`), cancellation, filesRoot, false, crop)
					.then((frames) => frames.length < 2 ? null : crop.coverage * frames.slice(1).reduce((max, frame, i) => Math.max(max, meanDelta(frames[i], frame)), 0))
					.catch(() => { cancellation.throwIfAborted(); return null; });
			}
			findings.push(finding("frozen-picture", movement !== null && movement >= L.sourceMeanDelta ? "warning" : "info",
				interval.from, interval.to, { exportMeanDelta: interval.value, sourceMeanDelta: movement, motionThreshold: L.sourceMeanDelta,
					minimumSeconds: L.freezeSeconds }, source ? [source.id] : []));
		}
		if (scan.stamps.length) for (const cut of cuts) {
			const pair = cutFrames(scan.stamps, cut.at);
			cut.before = scan.stamps[pair.before].at;
			cut.after = pair.after === undefined ? undefined : scan.stamps[pair.after].at;
		}
		if (!pictures) skipped.push("pictures-disabled");
		else if (scan.stamps.length) {
			const beginPictures = performance.now();
			const words = timeline.words.map((word) => ({ ...word, start: word.start - timelineStart, end: word.end - timelineStart }));
			const folder = path.join(workspace, "reviews");
			await fs.mkdir(folder, { recursive: true });
			if (!(await fs.lstat(folder)).isDirectory()) throw new Error("The reviews folder must be a directory.");
			await fs.mkdir(staged);
			startedPictures = true;
			omittedPictures = await evidencePictures(scan, staged, reviewId, words, cuts, findings, groups, cancellation);
			pictureSeconds = (performance.now() - beginPictures) / 1000;
		}
	};
	try {
		await withToolScratch(active, filesRoot, run, workspace);
		active.throwIfAborted();
		const report = { version: 1, projectId, file: relative, stale, sceneId: root.id, sceneNotice,
			expected: { timelineDuration: duration, profile }, observed,
		findings, cuts, pictures: groups, omittedPictureRows: omittedPictures, skipped,
		timing: { totalSeconds: (performance.now() - start) / 1000, scanSeconds, pictureSeconds } };
		if (groups.length) { await fs.rename(staged, published); promoted = true; }
		await atomicWrite(path.join(workspace, "review.json"), JSON.stringify(report, null, 2) + "\n", active);
		committed = true;
		return { ...(sceneNotice && { sceneNotice }), ...summarizeReview("review.json", findings, skipped), ...(skipped.includes("file-integrity") ?
			{ message: "FFmpeg and FFprobe are required for file checks. Only the saved timeline was checked." } : {}) };
	} finally {
		if (startedPictures && !promoted) await fs.rm(staged, { recursive: true, force: true });
		if (promoted && !committed) await fs.rm(published, { recursive: true, force: true });
	}
}

async function evidencePictures(scan: FileScan, staged: string, id: string, words: Parameters<typeof drawRangeView>[2]["words"],
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
	const video = await fs.open(scan.video, "r");
	let audio: Awaited<ReturnType<typeof fs.open>> | null = null;
	try {
		audio = scan.audio ? await fs.open(scan.audio, "r").catch(() => null) : null;
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
				const pairFrames = cutFrames(scan.stamps, page[i][0]);
				const pair = createCanvas(REVIEW_WIDTH * 2, REVIEW_HEIGHT);
				const pairCtx = pair.getContext("2d");
				for (const [slot, index] of [pairFrames.before, pairFrames.after].entries()) {
					if (index === undefined) continue;
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
					const sampleRate = scan.probe.sampleRate;
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
			await atomicWrite(path.join(staged, path.basename(name)), await canvas.encode("png"), signal);
			files.push(name);
			for (const [, row] of page) for (const entry of [...row.cuts, ...row.findings]) entry.picture = name;
		}
		return Math.max(0, all.length - pageSize * files.length);
	} finally { await Promise.all([video.close(), audio?.close()]); }
}
