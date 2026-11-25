import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getEffectiveRateAt } from "@/retime/resolve";
import { runBackgroundProcess, withToolScratch } from "@/retrieval/process";
import { toolsFromEnv } from "@/retrieval/server";
import { proxyFingerprintRegions } from "@/services/proxies/identity";
import type { TScene } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { outputClip, timelineItems } from "./draft-check";
import { activePictureFrame, pictureBytes, pictureEvents, pictureFeature, pictureHeight, pictureMatch, pictureWidth, sampleFractions,
	type PictureEvent, type PictureFrame } from "./draft-picture-metrics";
import { fileInside } from "./inside";

export const pictureDefaults = { limit: 120, distance: 0.038, freezeSeconds: 0.35, outlierDistance: 0.2 };
export type PictureOptions = typeof pictureDefaults;
type AddressedClip = ReturnType<typeof outputClip> & { mediaId: string };
type Shot = { clip: AddressedClip; lane: string; from: number; to: number; rate: number; still: boolean };
type Scan = { samples: Uint8Array[]; events: PictureEvent[]; omittedEvents: number; incomplete: boolean };
type SampledShot = { shot: Shot; scan: Scan; features: ReturnType<typeof pictureFeature>[] };
export type PictureFinding = {
	kind: "look-alike-shots" | "look-alike-run" | "missing-picture-media" | PictureEvent["kind"]; from: number; to: number;
	clips: AddressedClip[]; picture?: string; omittedClips?: number; rms?: number; matchingSamples?: number;
	frames?: number; seconds?: number; uses?: number;
};
type Finding = { finding: PictureFinding; images: Uint8Array[] };
export type PictureReport = {
	findings: PictureFinding[]; settings: PictureOptions; shots: number; sampled: number; skipped: number;
	limited: number; incompleteWindows: number; omittedEvents: number; evidenceOmitted: number; timedOut: boolean;
	missingFfmpeg: boolean;
};
type Media = { id: string; diskFile?: string; fileType?: string };

const maxFrames = 480;
const maxEvidence = 12;
const maxEventsPerShot = 4;
const allowedFormats = "mov,matroska,webm,avi,mpegts,mpeg,m4v,ogg,image2,png_pipe,jpeg_pipe,webp_pipe";
const rounded = (value: number) => Number(value.toFixed(6));
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
class MissingFfmpeg extends Error {}

async function mediaFile(directory: string, asset: Media) {
	const name = asset.diskFile;
	if (name && /^[\w-]+\.[a-z0-9]{1,10}$/i.test(name) && path.parse(name).name === asset.id &&
		/^(video|image)\//.test(asset.fileType ?? "")) return fileInside(directory, "media", name);
}

async function mediaFingerprint(file: string, signal: AbortSignal) {
	const input = await fs.open(file, "r");
	try {
		const { size, mtimeMs } = await input.stat();
		const hash = createHash("sha256").update(String(size));
		for (const { start, end } of proxyFingerprintRegions(size)) {
			signal.throwIfAborted();
			const bytes = Buffer.alloc(end - start);
			if ((await input.read(bytes, 0, bytes.length, start)).bytesRead !== bytes.length) throw new Error("Media changed during fingerprinting");
			hash.update(bytes);
		}
		const current = await input.stat();
		if (current.size !== size || current.mtimeMs !== mtimeMs) throw new Error("Media changed during fingerprinting");
		return { key: hash.digest("hex"), size, mtimeMs };
	} finally { await input.close(); }
}

async function decodeWindow(file: string, start: number, length: number, temp: string, root: string,
	signal: AbortSignal, still: boolean) {
	const [exe, ...defaults] = toolsFromEnv().ffmpeg;
	const raw = path.join(temp, "sample.rgb");
	const args = [...defaults, "-hide_banner", "-nostdin", "-v", "error", "-y", "-threads", "1",
		"-protocol_whitelist", "file", "-format_whitelist", allowedFormats,
		...(still ? [] : ["-ss", String(start), "-t", String(length)]), "-i", file,
		"-filter_complex_threads", "1", "-filter_complex",
		`[0:v:0]scale=${pictureWidth}:${pictureHeight}:flags=area,format=rgb24,settb=AVTB,split[pixels][timestamps]`];
	for (const [label, format, output] of [["pixels", "rawvideo", raw], ["timestamps", "framecrc", "-"]]) {
		args.push("-map", `[${label}]`, "-fps_mode", "passthrough", "-enc_time_base", "1:1000000",
			"-c:v", "rawvideo", "-threads", "1", "-frames:v", String(still ? 1 : maxFrames), "-f", format, output);
	}
	let stdout: string;
	try {
		({ stdout } = await runBackgroundProcess(exe, args, AbortSignal.any([signal, AbortSignal.timeout(5_000)]), root));
	} catch (error) {
		if (isMissing(error) && (error as Error).message === "tool exited with code 127") throw new MissingFfmpeg();
		throw error;
	}
	const rows = stdout.split(/\r?\n/);
	const timeBase = rows.find(row => row.startsWith("#tb 0:"))?.match(/(\d+)\/(\d+)/);
	const unit = timeBase ? Number(timeBase[1]) / Number(timeBase[2]) : 0;
	const bytes = await fs.readFile(raw);
	const stamps = rows.filter(row => /^0,/.test(row)).map(row => row.split(","));
	if (!unit || bytes.length !== stamps.length * pictureBytes) return { frames: [], capped: false };
	const frames = stamps.map(([, , pts], index): PictureFrame => ({
		at: start + Number(pts) * unit,
		rgb: bytes.subarray(index * pictureBytes, (index + 1) * pictureBytes),
	})).filter(({ at }) => Number.isFinite(at));
	if (frames.some((frame, i) => i > 0 && frame.at <= frames[i - 1].at)) return { frames: [], capped: false };
	return { frames, capped: stamps.length === maxFrames };
}

async function scanShot(shot: Shot, file: string, temp: string, directory: string, options: PictureOptions, signal: AbortSignal): Promise<Scan> {
	const duration = shot.to - shot.from;
	const anchors = sampleFractions.map(fraction => shot.from + duration * fraction);
	const windows = shot.still ? [{ from: 0, to: 0.1, anchors: [0, 0, 0] }] :
		duration <= 6 ? [{ from: shot.from, to: shot.to, anchors }] :
			anchors.map(at => ({ from: Math.max(shot.from, at - 0.6), to: Math.min(shot.to, at + 0.6), anchors: [at] }));
	const samples: Uint8Array[] = [];
	const events: PictureEvent[] = [];
	let omittedEvents = 0, incomplete = false;
	for (const window of windows) {
		signal.throwIfAborted();
		const read = (preroll: number) => {
			const start = Math.max(0, window.from - preroll);
			return decodeWindow(file, start, window.to - start, temp, directory, signal, shot.still);
		};
		let { frames, capped } = await read(0.25);
		if (!shot.still && window.from > 0.25 && (!frames.length || frames[0].at > window.from + 0.000001)) {
			({ frames, capped } = await read(2));
		}
		if (capped) incomplete = true;
		for (const at of window.anchors) {
			const frame = shot.still ? frames[0] : activePictureFrame(frames, at, window.to, capped);
			if (frame) samples.push(frame.rgb.slice());
		}
		if (shot.still) continue;
		const inside = frames.filter(frame => frame.at >= window.from && frame.at < window.to);
		const carried = activePictureFrame(frames, window.from, window.to, capped);
		if (carried && carried.at < window.from) inside.unshift({ ...carried, at: window.from });
		const found = pictureEvents(inside, options.freezeSeconds * shot.rate, options.outlierDistance);
		for (const event of found) {
			if (events.length >= maxEventsPerShot) { omittedEvents++; continue; }
			events.push({ ...event, frame: { ...event.frame, rgb: event.frame.rgb.slice() } });
		}
	}
	return { samples, events, omittedEvents, incomplete: incomplete || samples.length !== sampleFractions.length || windows.length > 1 };
}

async function groupsAndRuns(sampled: SampledShot[], shots: Shot[], threshold: number, signal: AbortSignal): Promise<Finding[]> {
	const groups: SampledShot[][] = [];
	const membership = new Map<Shot, number>();
	const results: Finding[] = [];
	const score = (a: SampledShot, b: SampledShot) => pictureMatch(a.features, b.features, threshold);
	const sampleClips = (clips: AddressedClip[], other: AddressedClip) =>
		clips.slice(0, 5).includes(other) ? clips.slice(0, 5) : [...clips.slice(0, 4), other];
	for (const [index, shot] of sampled.entries()) {
		if (index % 16 === 0) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			signal.throwIfAborted();
		}
		const group = groups.find(list => list.every(item => score(shot, item)));
		if (group) group.push(shot);
		else groups.push([shot]);
	}
	for (const [index, group] of groups.entries()) {
		const a = group[0];
		const b = group.find(item => item.shot.clip.mediaId !== a.shot.clip.mediaId);
		if (!b) continue;
		const match = score(a, b)!;
		for (const member of group) membership.set(member.shot, index);
		const clips = group.map(({ shot }) => shot.clip);
		results.push({ finding: { kind: "look-alike-shots", from: clips[0].from, to: Math.max(...clips.map(clip => clip.to)),
			clips: sampleClips(clips, b.shot.clip), omittedClips: Math.max(0, clips.length - 5), uses: clips.length,
			rms: rounded(match.rms), matchingSamples: match.matches },
			images: [a.scan.samples[match.evidenceIndex], b.scan.samples[match.evidenceIndex]] });
	}
	const lanes = new Map<string, Shot[]>();
	for (const shot of shots) {
		const lane = lanes.get(shot.lane);
		if (lane) lane.push(shot);
		else lanes.set(shot.lane, [shot]);
	}
	for (const lane of lanes.values()) {
		for (let first = 0, next = 1; first < lane.length; first = next, next++) {
			const group = membership.get(lane[first]);
			if (group === undefined) continue;
			while (next < lane.length && membership.get(lane[next]) === group && lane[next - 1].clip.to === lane[next].clip.from) next++;
			const run = lane.slice(first, next);
			const second = run.find(shot => shot.clip.mediaId !== run[0].clip.mediaId);
			if (!second) continue;
			const a = groups[group].find(value => value.shot === run[0])!;
			const b = groups[group].find(value => value.shot === second)!;
			const match = score(a, b)!;
			results.push({ finding: { kind: "look-alike-run", from: a.shot.clip.from, to: run.at(-1)!.clip.to,
				clips: sampleClips(run.map(({ clip }) => clip), b.shot.clip), omittedClips: Math.max(0, run.length - 5),
				uses: run.length, rms: rounded(match.rms), matchingSamples: match.matches },
				images: [a.scan.samples[match.evidenceIndex], b.scan.samples[match.evidenceIndex]] });
		}
	}
	return results;
}

async function writeEvidence(rows: Finding[], directory: string, signal: AbortSignal) {
	if (!rows.length) return 0;
	const temp = await fs.realpath(tmpdir());
	const projects = await fs.realpath(path.dirname(directory));
	const relative = path.relative(projects, temp);
	if (!relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) return rows.length;
	const { createCanvas } = await import("@napi-rs/canvas");
	const evidence = await fs.mkdtemp(path.join(temp, "bopencut-draft-pictures-"));
	for (const [index, row] of rows.slice(0, maxEvidence).entries()) {
		signal.throwIfAborted();
		const canvas = createCanvas(pictureWidth * row.images.length, pictureHeight);
		const context = canvas.getContext("2d");
		for (const [slot, rgb] of row.images.entries()) {
			const image = context.createImageData(pictureWidth, pictureHeight);
			for (let p = 0, j = 0; p < rgb.length; p += 3, j += 4) {
				image.data[j] = rgb[p];
				image.data[j + 1] = rgb[p + 1];
				image.data[j + 2] = rgb[p + 2];
				image.data[j + 3] = 255;
			}
			context.putImageData(image, pictureWidth * slot, 0);
		}
		const file = path.join(evidence, `finding-${index + 1}.png`);
		await fs.writeFile(file, canvas.toBuffer("image/png"), { mode: 0o600, flag: "wx" });
		row.finding.picture = file;
	}
	return Math.max(0, rows.length - maxEvidence);
}

export async function inspectDraftPictures({ root, scenes, media, directory, from, to, options, signal, budgetMs }: {
	root: TScene; scenes: TScene[]; media: Media[]; directory: string; from: number; to: number;
	options: PictureOptions; signal: AbortSignal; budgetMs: number;
}): Promise<PictureReport> {
	const start = Math.round(from * TICKS_PER_SECOND), end = Math.round(to * TICKS_PER_SECOND);
	const shots: Shot[] = [];
	const visited = { truncated: false };
	for (const { element, clip, origin, lane } of timelineItems(root, scenes, signal, visited)) {
		if ((element.type !== "video" && element.type !== "image") || clip.from >= end || clip.to <= start) continue;
		const first = Math.max(start, clip.from), last = Math.min(end, clip.to);
		const rate = element.type === "video" ? getEffectiveRateAt({ retime: element.retime }) : 1;
		shots.push({ clip: { ...outputClip({ ...clip, from: first, to: last }), mediaId: element.mediaId }, lane, rate,
			from: (element.trimStart + (first - origin) * rate) / TICKS_PER_SECOND,
			to: (element.trimStart + (last - origin) * rate) / TICKS_PER_SECOND, still: element.type === "image" });
	}
	shots.sort((a, b) => a.clip.from - b.clip.from || a.clip.to - b.clip.to);
	const report: PictureReport = { findings: [], settings: options, shots: shots.length, sampled: 0, skipped: 0,
		limited: Math.max(0, shots.length - options.limit), incompleteWindows: 0, omittedEvents: 0,
		evidenceOmitted: 0, timedOut: false, missingFfmpeg: false };
	if (!shots.length) return report;
	const timeout = AbortSignal.timeout(budgetMs);
	const scanSignal = AbortSignal.any([signal, timeout]);
	const assets = new Map(media.map(asset => [asset.id, asset]));
	const findings: Finding[] = [];
	const sampled: SampledShot[] = [];
	const missing = (shot: Shot) => findings.push({ finding: { kind: "missing-picture-media", from: shot.clip.from,
		to: shot.clip.to, clips: [shot.clip] }, images: [] });
	const files = new Map<string, { file: string; key: string; size: number; mtimeMs: number } | undefined>();
	const cache = new Map<string, Scan>();
	await withToolScratch(signal, path.dirname(directory), async (temp) => {
		for (const shot of shots.slice(0, options.limit)) {
			if (scanSignal.aborted) break;
			const id = shot.clip.mediaId;
			let input = files.get(id)?.file;
			try {
				if (!files.has(id)) {
					const asset = assets.get(id);
					input = (asset && await mediaFile(directory, asset)) ?? undefined;
					files.set(id, input ? { file: input, ...await mediaFingerprint(input, scanSignal) } : undefined);
				}
				const source = files.get(id);
				if (!source) { missing(shot); continue; }
				const key = JSON.stringify([source.key, shot.still, shot.still ? 0 : shot.from, shot.still ? 0 : shot.to, shot.rate]);
				const scan = cache.get(key) ?? await scanShot(shot, source.file, temp, path.dirname(directory), options, scanSignal);
				const after = await fs.stat(source.file);
				if (after.size !== source.size || after.mtimeMs !== source.mtimeMs) continue;
				cache.set(key, scan);
				if (scan.incomplete) report.incompleteWindows++;
				report.omittedEvents += scan.omittedEvents;
				if (scan.samples.length === sampleFractions.length) {
					sampled.push({ shot, scan, features: scan.samples.map(pictureFeature) });
				}
				for (const event of scan.events) {
					const from = rounded(shot.clip.from + (event.from - shot.from) / shot.rate);
					const to = rounded(shot.clip.from + (event.to - shot.from) / shot.rate);
					findings.push({ finding: { kind: event.kind, from, to, clips: [shot.clip], frames: event.frames,
						rms: rounded(event.distance), seconds: rounded(to - from) }, images: [event.frame.rgb] });
				}
			} catch (error) {
				if (scanSignal.aborted) break;
				if (error instanceof MissingFfmpeg) {
					report.missingFfmpeg = true;
					break;
				}
				if (input && await fs.stat(input).then(() => false, isMissing)) {
					files.set(id, undefined);
					missing(shot);
				}
			}
		}
	});
	signal.throwIfAborted();
	report.timedOut = timeout.aborted;
	report.sampled = sampled.length;
	report.skipped = Math.min(shots.length, options.limit) - report.sampled;
	findings.push(...await groupsAndRuns(sampled, shots, options.distance, signal));
	findings.sort((a, b) => a.finding.from - b.finding.from || a.finding.to - b.finding.to);
	report.evidenceOmitted = await writeEvidence(findings.filter(row => row.images.length), directory, signal);
	report.findings = findings.map(({ finding }) => finding);
	return report;
}
