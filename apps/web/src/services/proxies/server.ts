import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runBackgroundProcess } from "@/retrieval/process";
import { toolsFromEnv } from "@/retrieval/server";
import { projectDir, safeId } from "@/services/storage/server/files";
import { acquireProxyWriter, ownsProxyWriter, proxyDirectory, proxyFile, ProxyWriterLost, requireProxyWriter } from "./cache-files";
import { cachedProxyKey, proxyFingerprintRegions, proxyProfile } from "./identity";
import type { ProxyInfo, ProxyUpdate } from "./mapping";

function byteSetting(value: string | undefined, fallback: number) {
	const bytes = Number(value);
	return value && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : fallback;
}
const reserve = () => byteSetting(process.env.BOPENCUT_PROXY_FREE_BYTES, 5_000_000_000);
const limit = () => byteSetting(process.env.BOPENCUT_PROXY_LIMIT_BYTES, 8_000_000_000);
class LowDisk extends Error {}
class EncoderBusy extends Error {}
/** `failed` counts sources in a row: builds and drivers fail in more ways than the messages below. */
type CudaSupport = { disabled: boolean; unsupported: Set<string>; failed: number };
type EncoderCapabilities = { encoders: string[] | null; expiresAt: number; error?: string; busy?: boolean; cuda?: CudaSupport };
const isBusy = (error: unknown) => /temporarily unavailable|encoder is busy|too many (sessions|concurrent)|out of memory|no free (session|encoder)/i
	.test((error as { stderr?: string })?.stderr ?? "");

function rememberCudaFailure(cuda: CudaSupport, codec: string, error: unknown) {
	const stderr = (error as { stderr?: string })?.stderr ?? "";
	if (/no such filter.*scale_cuda|cannot load (?:nv|lib)cuda|out of memory|cuda_error_out_of_memory/i.test(stderr)) cuda.disabled = true;
	else if (/hardware is lacking required capabilities|(?:codec|pixel format).*not supported|(?:does not support|unsupported).*?(?:codec|pixel format)|no device available for decoder/i.test(stderr)) {
		cuda.unsupported.add(codec);
	}
	if (++cuda.failed >= 2) cuda.disabled = true;
}
export async function fingerprint(file: string) {
	const input = await fs.open(file, "r");
	try {
		const { size, mtimeMs } = await input.stat();
		const hash = createHash("sha256").update(String(size));
		for (const { start, end } of proxyFingerprintRegions(size)) {
			const bytes = Buffer.alloc(end - start);
			const { bytesRead } = await input.read(bytes, 0, bytes.length, start);
			if (bytesRead !== bytes.length) throw new Error("Media changed while reading the proxy fingerprint");
			hash.update(bytes.subarray(0, bytesRead));
		}
		const after = await input.stat();
		if (after.size !== size || after.mtimeMs !== mtimeMs) throw new Error("Media changed while reading the proxy fingerprint");
		return { key: hash.digest("hex") + "-" + proxyProfile, size, mtimeMs };
	} finally { await input.close(); }
}

type Source = Awaited<ReturnType<typeof fingerprint>> & { file: string };
async function sameSource(source: Source) {
	const stat = await fs.lstat(source.file).catch(() => undefined);
	return stat?.isFile() && stat.size === source.size && stat.mtimeMs === source.mtimeMs;
}

async function sourcePath(project: string, media: string) {
	const dir = path.join(projectDir(project), "media");
	const meta = JSON.parse(await fs.readFile(path.join(dir, "_metadata", safeId(media) + ".json"), "utf8"));
	if (meta.type !== "video" || typeof meta.diskFile !== "string" ||
		!new RegExp("^" + media + "\\.[a-z0-9]{1,10}$").test(meta.diskFile)) return;
	const file = path.join(dir, meta.diskFile);
	if ((await fs.lstat(file)).isFile()) return file;
}

type Probe = {
	streams: {
		width: number; height: number; codec_name?: string; pix_fmt: string; time_base: string; duration?: string; sample_aspect_ratio?: string;
		color_range?: string; color_space?: string; color_transfer?: string; color_primaries?: string;
		tags?: { alpha_mode?: string }; side_data_list?: { rotation?: number; displaymatrix?: string }[];
	}[];
	frames: { best_effort_timestamp: number; key_frame: number; pict_type: string }[];
};

function command() { return toolsFromEnv().ffmpeg; }
function probeCommand() {
	const [exe] = command();
	const ffprobe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
	return path.isAbsolute(exe) ? path.join(path.dirname(exe), ffprobe) : ffprobe;
}
const safeInput = ["-format_whitelist", "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts", "-protocol_whitelist", "file"];
function run(dir: string, args: string[], signal: AbortSignal) {
	const [exe, ...leading] = command();
	return runBackgroundProcess(exe, [...leading, "-nostdin", ...args], signal, dir);
}
async function encode(dir: string, args: string[], output: string, signal: AbortSignal) {
	await requireProxyWriter(dir);
	const stall = new AbortController();
	let previousSize = -1;
	let progress = Date.now();
	const monitor = setInterval(() => {
		void ownsProxyWriter(dir).then(owns => { if (!owns) stall.abort(new ProxyWriterLost()); });
		void fs.stat(output).then(({ size }) => {
			if (size !== previousSize) { previousSize = size; progress = Date.now(); }
		}).catch(() => {}).finally(() => {
			if (Date.now() - progress > 30_000) stall.abort();
		});
	}, 1_000);
	try { await run(dir, args, AbortSignal.any([signal, stall.signal])); }
	finally {
		clearInterval(monitor);
		if (stall.signal.reason instanceof ProxyWriterLost) throw stall.signal.reason;
		await requireProxyWriter(dir);
	}
}
async function probe(dir: string, file: string, signal: AbortSignal): Promise<Probe> {
	const result = await runBackgroundProcess(probeCommand(), ["-v", "error", ...safeInput, "-select_streams", "v",
		"-show_frames", "-show_streams", "-show_entries",
		"frame=best_effort_timestamp,key_frame,pict_type:stream=width,height,codec_name,pix_fmt,time_base,duration,sample_aspect_ratio,color_range,color_space,color_transfer,color_primaries:stream_tags=alpha_mode:stream_side_data=rotation,displaymatrix",
		"-of", "json", file], signal, dir);
	return JSON.parse(result.stdout);
}
function timestamps(probe: Probe) {
	const [num, den] = (probe.streams[0]?.time_base ?? "").split("/").map(Number);
	const times = (probe.frames ?? []).map((frame) => frame.best_effort_timestamp * num / den);
	return times.length && times.every((t, i) => Number.isFinite(t) && (!i || t > times[i - 1])) ? times : undefined;
}
function shortGop(frames: Probe["frames"]) {
	let position = 8;
	for (const frame of frames) {
		position = frame.key_frame ? 0 : position + 1;
		if (position >= 8) return false;
	}
	return true;
}
async function files(dir: string) {
	const entries = await fs.readdir(dir).catch(() => []);
	const result = await Promise.all(entries.filter((name) => name.endsWith(".mp4") && cachedProxyKey.test(name.slice(0, -4)))
		.map(async (name) => {
			const video = await proxyFile(path.join(dir, name));
			if (!video) return;
			const sidecar = await proxyFile(path.join(dir, name.replace(/\.mp4$/, ".json")));
			return { name, stat: { size: video.size + (sidecar?.size ?? 0), mtimeMs: video.mtimeMs } };
		}));
	return result.filter(entry => entry !== undefined);
}
async function cleanInterruptedJobs(dir: string) {
	await requireProxyWriter(dir);
	const names = new Set(await fs.readdir(dir));
	for (const name of names) {
		const key = path.basename(name, path.extname(name));
		const extension = path.extname(name);
		if (/^\.job-[a-f0-9-]{36}\.mp4(?:\.json)?$/.test(name) ||
			(cachedProxyKey.test(key) && (extension === ".mp4" || extension === ".json") &&
				!names.has(key + (extension === ".mp4" ? ".json" : ".mp4")))) {
			const file = path.join(dir, name);
			if (await proxyFile(file)) {
				await requireProxyWriter(dir);
				await fs.rm(file, { force: true }).catch(() => {});
			}
		}
	}
}
export async function ensureProxySpace(bytes: number, alreadyWritten = 0, dir?: string): Promise<number> {
	dir ??= await proxyDirectory();
	if (!dir) throw new LowDisk();
	const available = await fs.statfs(dir);
	let free = available.bavail * available.bsize;
	const required = reserve() + Math.max(0, bytes - alreadyWritten);
	const entries = await files(dir);
	let used = entries.reduce((n, f) => n + f.stat.size, 0);
	if (bytes > limit() || free + used < required) throw new LowDisk();
	for (const entry of entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
		if (used + bytes <= limit() && free >= required) break;
		const video = path.join(dir, entry.name);
		if (!await proxyFile(video)) continue;
		await requireProxyWriter(dir);
		await fs.rm(video, { force: true }).catch(() => {});
		if (await proxyFile(video)) continue;
		const sidecar = path.join(dir, entry.name.replace(/\.mp4$/, ".json"));
		if (await proxyFile(sidecar)) {
			await requireProxyWriter(dir);
			await fs.rm(sidecar, { force: true });
		}
		used -= entry.stat.size;
		free += entry.stat.size;
		notifyEvicted(entry.name.slice(0, -4));
	}
	const remaining = await fs.statfs(dir);
	if (used + bytes > limit() || remaining.bavail * remaining.bsize < required) throw new LowDisk();
	return used;
}

async function cached(dir: string, source: Source, writable: boolean): Promise<ProxyInfo | undefined> {
	const video = path.join(dir, source.key + ".mp4");
	const metadata = path.join(dir, source.key + ".json");
	if (!await proxyFile(video) || !await proxyFile(metadata)) return;
	const info = await fs.readFile(metadata, "utf8").then(JSON.parse).catch(() => null);
	if (info?.key !== source.key || info.size !== source.size || !await sameSource(source)) return;
	if (writable && await ownsProxyWriter(dir)) { const now = new Date(); await fs.utimes(video, now, now).catch(() => {}); }
	return info;
}

function quarterTurn(stream: Probe["streams"][number]) {
	const transform = stream.side_data_list?.find(data => data.displaymatrix || data.rotation !== undefined);
	if (!transform) return 0;
	const values = transform.displaymatrix?.trim().split("\n").flatMap(line => line.split(":")[1]?.trim().split(/\s+/).map(Number) ?? []);
	if (values?.length !== 9) return;
	const [a, b, c, d, e, f, x, y, w] = values;
	const unit = 65536;
	if (c || f || x || y || w !== 1073741824 || a * e - b * d !== unit * unit ||
		!((!b && !d && Math.abs(a) === unit && a === e) || (!a && !e && Math.abs(b) === unit && b === -d))) return;
	return a === 0 ? 90 : a < 0 ? 180 : 0;
}

async function prepare(dir: string, identity: Source, software: boolean, encoders: string[], cuda: CudaSupport | undefined, signal: AbortSignal): Promise<ProxyInfo | undefined> {
	const { file, key, size } = identity;
	const video = path.join(dir, key + ".mp4");
	const metadata = path.join(dir, key + ".json");
	for (const candidate of [video, metadata]) {
		const existing = await fs.lstat(candidate).catch(() => undefined);
		if (existing && (!existing.isFile() || existing.nlink !== 1)) return;
	}
	const source = await probe(dir, file, signal);
	// The editor and FFmpeg can select different tracks when there is more than one.
	if (source.streams.length !== 1) return;
	const stream = source.streams[0];
	const pts = timestamps(source);
	// This profile is SDR, eight-bit YUV without alpha.
	if (!stream || !pts || pts[0] < 0 || !/^(yuvj?420p|nv12)$/.test(stream.pix_fmt) ||
		stream.tags?.alpha_mode === "1" || ["smpte2084", "arib-std-b67"].includes(stream.color_transfer ?? "")) return;
	if (stream.sample_aspect_ratio && !["1:1", "N/A"].includes(stream.sample_aspect_ratio)) return;
	const duration = Number(stream.duration) || pts.at(-1)! - pts[0];
	if (duration < 2) return;
	if (Math.min(stream.width, stream.height) <= 540 && shortGop(source.frames)) return;
	const rotation = quarterTurn(stream);
	if (rotation === undefined) return;
	const [width, height] = Math.abs(rotation % 180) ? [stream.height, stream.width] : [stream.width, stream.height];
	const scale = Math.min(1, 960 / Math.max(width, height), 540 / Math.min(width, height));
	const w = Math.max(2, Math.round(width * scale / 2) * 2);
	const h = Math.max(2, Math.round(height * scale / 2) * 2);
	const known = (value?: string) => value && value !== "unknown" ? value : undefined;
	const range = known(stream.color_range) ?? (stream.pix_fmt.startsWith("yuvj") ? "pc" : undefined);
	// CUDA frames bypass autorotation, and the CUDA scaler does not match the full-range CPU path.
	const cudaCodec = rotation === 0 && range !== "pc" && /^(h264|hevc)$/.test(stream.codec_name ?? "") ? stream.codec_name : undefined;
	const colors = [
		["-color_range", range], ["-colorspace", known(stream.color_space)],
		["-color_trc", known(stream.color_transfer)], ["-color_primaries", known(stream.color_primaries)],
	];
	const filter = `scale=${w}:${h}:flags=lanczos${range === "pc" ? ":in_range=full:out_range=full" : ""},setsar=1`;
	const temp = path.join(dir, ".job-" + randomUUID() + ".mp4");
	const sidecar = temp + ".json";
	const estimate = Math.ceil(duration * 650_000 + pts.length * 48 + 4096);
	const used = await ensureProxySpace(estimate, 0, dir);
	const free = await fs.statfs(dir);
	const maxBytes = Math.floor(Math.min(limit() - used, free.bavail * free.bsize - reserve()));
	if (maxBytes < 1024) throw new LowDisk();
	const inspect = async (fullCuda: boolean) => {
		const stat = await fs.stat(temp);
		if (stat.size >= maxBytes) throw new LowDisk();
		const output = await probe(dir, temp, signal);
		const proxy = timestamps(output);
		const encoded = output.streams[0];
		// A constant offset is fine. Drift, reordering or duplicated samples invalidate the proxy.
		if (!proxy || proxy.length !== pts.length || output.frames.some(f => !f.key_frame || (fullCuda ? f.pict_type !== "I" : f.pict_type === "B")) ||
			encoded?.width !== w || encoded.height !== h || (range && encoded.color_range !== range) ||
			(fullCuda && (quarterTurn(encoded) !== 0 || encoded.sample_aspect_ratio !== "1:1")) ||
			(known(stream.color_space) && encoded.color_space !== stream.color_space) ||
			(known(stream.color_transfer) && encoded.color_transfer !== stream.color_transfer) ||
			(known(stream.color_primaries) && encoded.color_primaries !== stream.color_primaries) ||
			proxy.some((t, i) => Math.abs(t - proxy[0] - (pts[i] - pts[0])) > 0.000002)) return;
		return { stat, proxy };
	};
	try {
		if (!await sameSource(identity)) throw new Error("Proxy source changed before encoding");
		let result: Awaited<ReturnType<typeof inspect>>;
		let encoding = "";
		let busy = false;
		let tooSmall = false;
		attempts: for (const encoder of [...encoders, ...(software ? ["libx264"] : [])]) {
			const hardware = encoder === "h264_nvenc" ? [["-hwaccel", "cuda"], []] : encoder === "libx264" ? [[]] : [["-hwaccel", "auto"], []];
			if (encoder === "h264_nvenc" && cudaCodec && cuda && !cuda.disabled && !cuda.unsupported.has(cudaCodec)) {
				hardware.unshift(["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
			}
			for (const decode of hardware) {
				const fullCuda = decode.includes("-hwaccel_output_format");
				const quality = encoder === "h264_nvenc" ? ["-preset", "p4", "-rc", "vbr", "-cq", "25", "-b:v", "0"]
					: encoder === "libx264" ? ["-preset", "ultrafast", "-crf", "24"] : ["-b:v", "4800k"];
				quality.push("-maxrate", "5200k", "-bufsize", "5200k");
				try {
					await encode(dir, ["-v", "error", "-y", ...decode, ...safeInput, "-i", file, "-map", "0:v:0", "-an", "-sn", "-dn",
						...(fullCuda ? ["-vf", `scale_cuda=${w}:${h}:interp_algo=lanczos:format=yuv420p,setsar=1`] : ["-vf", filter, "-pix_fmt", "yuv420p"]),
						"-fps_mode", "passthrough",
						"-enc_time_base", stream.time_base.replace("/", ":"), "-video_track_timescale", stream.time_base.split("/")[1],
						...colors.flatMap(([flag, value]) => flag && value ? [flag, value] : []),
						"-c:v", encoder, ...quality, "-g", encoder === "h264_nvenc" ? "0" : "1", "-bf", "0", "-fs", String(maxBytes), "-movflags", "+faststart", temp], temp, signal);
				} catch (error) {
					if (error instanceof ProxyWriterLost) throw error;
					signal.throwIfAborted();
					if (fullCuda && cuda && cudaCodec) rememberCudaFailure(cuda, cudaCodec, error);
					else {
						busy ||= isBusy(error);
						tooSmall ||= /dimension less than the minimum/i.test((error as { stderr?: string })?.stderr ?? "");
					}
					continue;
				}
				if (!await sameSource(identity)) throw new Error("Proxy source changed during encoding");
				try { result = await inspect(fullCuda); }
				catch (error) {
					if (!fullCuda || error instanceof ProxyWriterLost) throw error;
					signal.throwIfAborted();
					continue;
				}
				if (!result && fullCuda) continue;
				if (!result) return;
				if (fullCuda && cuda) cuda.failed = 0;
				encoding = encoder + (fullCuda ? ":scale_cuda" : decode[1] ? ":" + decode[1] : "");
				break attempts;
			}
		}
		if (!result) {
			if (busy) throw new EncoderBusy();
			if (tooSmall) return;
			throw new Error("No working proxy encoder");
		}
		const { stat, proxy } = result;
		if (!await sameSource(identity) || (await fingerprint(file)).key !== key) return;
		const info = { key, width, height, source: pts, proxy, size, duration, frameCount: pts.length, encoding };
		const serialized = JSON.stringify(info);
		await ensureProxySpace(stat.size + Buffer.byteLength(serialized), stat.size, dir);
		await requireProxyWriter(dir);
		await fs.writeFile(sidecar, serialized);
		signal.throwIfAborted();
		await requireProxyWriter(dir);
		await fs.rename(temp, video);
		try {
			signal.throwIfAborted();
			await requireProxyWriter(dir);
			await fs.rename(sidecar, metadata);
		} catch (error) {
			if (await ownsProxyWriter(dir)) await fs.rm(video, { force: true });
			throw error;
		}
		return info;
	} finally {
		if (await ownsProxyWriter(dir)) await Promise.all([temp, sidecar].map(file => fs.rm(file, { force: true }).catch(() => {})));
	}
}

type Session = {
	project: string; ids: string[]; software: boolean; paused: boolean; send: (update: ProxyUpdate) => void;
	/** False: existing proxies are used and no tool is started. */
	build: boolean;
	/** Set when the person asks to try again; a value is used once. */
	retry?: number;
	done: Set<string>; revisions: Map<string, number>; diskBlocked: Set<string>; bytes: number; written: Map<string, string>;
	sequence: number; readerChecked?: number; readerPending: boolean;
	/** Consecutive tool failures stop this session until it is reopened. */
	failedInRow: number; stopped?: string;
};
type Job = { session: Session; id: string; revision: number; source?: Source; controller: AbortController };
const sessions = new Map<string, Session>();
const pauses = new Set<symbol>();
const failures = new Set<string>();
/** Sources that failed before the person asked to try again. They do not stop preparation a second time. */
const failedBefore = new Set<string>();
const usedRetries = new Set<number>();
let active: Job | undefined;
let running = false;
let needsPump = false;
let initialized: string | undefined;
let wiping = false;
let idle: PromiseWithResolvers<void> | undefined;
let capabilities: EncoderCapabilities | undefined;
const failureLimit = 3;
const checkLimit = 60_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const isPaused = () => pauses.size > 0 || [...sessions.values()].some(entry => entry.paused);
function send(session: Session, state: ProxyUpdate["state"], details?: Partial<ProxyUpdate>) {
	const error = state === "failed" ? session.stopped ?? capabilities?.error : undefined;
	session.send({ state, bytes: session.bytes, done: session.done.size, total: session.ids.length, ...(error && { error }), ...details });
}
const errorText = (error: unknown) => {
	const { message = String(error), stderr } = error as { message?: string; stderr?: string };
	return [message, stderr?.trim().split("\n").at(-1)].filter(Boolean).join(": ").slice(0, 300);
};
function notifyEvicted(key: string) {
	for (const session of sessions.values()) {
		for (const [id, published] of session.written) {
			if (published !== key) continue;
			session.written.delete(id);
			send(session, "preparing", { evicted: key });
		}
	}
}
function usesJob(session: Session, job: Job) {
	return session === job.session && session.ids.includes(job.id) &&
		(session.revisions.get(job.id) ?? 0) === job.revision;
}
async function keepNeededJob() {
	const job = active;
	if (!job) return;
	if (isPaused()) { job.controller.abort(); return; }
	if ([...sessions.values()].some(session => usesJob(session, job))) return;
	if (job.source) {
		for (const session of sessions.values()) {
			if (!session.build) continue;
			for (const id of session.ids) {
				if (active !== job || job.controller.signal.aborted) return;
				const file = await sourcePath(session.project, id).catch(() => undefined);
				const key = file && (file === job.source.file ? job.source.key : (await fingerprint(file).catch(() => null))?.key);
				if (key === job.source.key && [...sessions.values()].includes(session) &&
					session.ids.includes(id) && await sameSource(job.source)) return;
			}
		}
	}
	if (active === job && ![...sessions.values()].some(session => usesJob(session, job))) job.controller.abort();
}
const readerInterval = 60_000;
export function updateSession(id: string, changes: Pick<Partial<Session>, "ids" | "paused">, sequence: number, replaced: string[] = []) {
	const session = sessions.get(id);
	if (!session || sequence <= session.sequence) return;
	session.sequence = sequence;
	Object.assign(session, changes);
	if (!session.readerPending && session.readerChecked !== undefined && Date.now() - session.readerChecked >= readerInterval) {
		session.readerChecked = undefined;
		session.done.clear();
	}
	for (const id of session.done) if (!session.ids.includes(id) || replaced.includes(id)) session.done.delete(id);
	if ((!session.build || session.stopped) && session.ids.some(id => !session.done.has(id))) session.readerChecked = undefined;
	for (const id of replaced) session.revisions.set(id, (session.revisions.get(id) ?? 0) + 1);
	for (const id of session.written.keys()) if (!session.ids.includes(id) || replaced.includes(id)) session.written.delete(id);
	for (const id of session.diskBlocked) if (!session.ids.includes(id) || replaced.includes(id)) session.diskBlocked.delete(id);
	void keepNeededJob();
	void pump();
}
export function openSession(id: string, session: Omit<Session, "done" | "revisions" | "diskBlocked" | "bytes" | "written" | "sequence" | "readerChecked" | "readerPending" | "failedInRow" | "stopped">) {
	const entry = { ...session, done: new Set<string>(), revisions: new Map<string, number>(), diskBlocked: new Set<string>(), bytes: 0, written: new Map<string, string>(), sequence: 0, readerPending: false, failedInRow: 0 };
	sessions.set(id, entry);
	// Tools that failed are tried again when a project is opened or the setting is changed, not on their own.
	if (entry.build) {
		if (!capabilities?.encoders?.length) capabilities = undefined;
		if (entry.retry && !usedRetries.has(entry.retry)) {
			usedRetries.add(entry.retry);
			for (const key of failures) failedBefore.add(key);
			failures.clear();
		}
	}
	void keepNeededJob();
	void pump();
	return () => {
		if (sessions.get(id) !== entry) return;
		sessions.delete(id);
		void keepNeededJob();
		void pump();
	};
}
export function pauseProxyJobs() {
	const token = Symbol();
	pauses.add(token);
	active?.controller.abort();
	return () => { pauses.delete(token); void pump(); };
}

function retryLater() {
	if (retryTimer || !sessions.size) return;
	retryTimer = setTimeout(() => { retryTimer = undefined; void pump(); }, 30_000);
	retryTimer.unref?.();
}
async function detectEncoders(dir: string, signal: AbortSignal) {
	if (capabilities && capabilities.expiresAt > Date.now()) {
		if (capabilities.busy) throw new EncoderBusy();
		return capabilities;
	}
	let available: string[] | null;
	let error: string | undefined;
	let busy = false;
	// The first start of a program can be slow.
	const checkTime = AbortSignal.timeout(checkLimit);
	try {
		const probeSignal = AbortSignal.any([signal, checkTime]);
		await runBackgroundProcess(probeCommand(), ["-version"], probeSignal, dir);
		const { stdout } = await run(dir, ["-hide_banner", "-encoders"], probeSignal);
		const names = process.platform === "darwin" ? ["h264_videotoolbox"] : ["h264_nvenc", "h264_qsv", "h264_amf"];
		available = [];
		for (const encoder of names) {
			if (!stdout.includes(encoder)) continue;
			try {
				// Some encoders refuse smaller pictures.
				await run(dir, ["-v", "error", "-f", "lavfi", "-i", "color=s=256x256", "-frames:v", "1",
					"-c:v", encoder, "-g", encoder === "h264_nvenc" ? "0" : "1", "-bf", "0", "-f", "null", "-"],
					AbortSignal.any([signal, AbortSignal.timeout(12_000)]));
				available.push(encoder);
			} catch (cause) {
				signal.throwIfAborted();
				busy ||= isBusy(cause);
			}
		}
	} catch (cause) {
		signal.throwIfAborted();
		available = null;
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
			error = checkTime.aborted ? `the FFmpeg check took longer than ${checkLimit / 1000} s` : errorText(cause);
		}
	}
	if (available && !available.length && busy) throw new EncoderBusy();
	let cuda: CudaSupport | undefined;
	if (available?.includes("h264_nvenc") && !checkTime.aborted) {
		try {
			const { stdout } = await run(dir, ["-hide_banner", "-filters"], AbortSignal.any([signal, checkTime]));
			if (/^\s*\S+\s+scale_cuda\s+V->V\b/m.test(stdout)) cuda = { disabled: false, unsupported: new Set(), failed: 0 };
		} catch { signal.throwIfAborted(); }
	}
	capabilities = { encoders: available, expiresAt: available?.length ? Date.now() + 300_000 : Infinity, error, cuda };
	return capabilities;
}

async function pump() {
	if (wiping || !sessions.size || isPaused()) return;
	if (running) { needsPump = true; return; }
	const readerDue = (session: Session) => session.readerChecked === undefined || session.readerPending;
	if (![...sessions.values()].some(readerDue)) {
		for (const session of sessions.values()) send(session, !session.build ? "off" : session.stopped ? "failed" : "readonly");
		return;
	}
	running = true;
	idle = Promise.withResolvers<void>();
	try {
		const dir = await proxyDirectory(true);
		if (!dir) {
			for (const session of sessions.values()) {
				session.readerChecked ??= Date.now();
				session.readerPending = false;
				send(session, session.build ? "readonly" : "off");
			}
			return;
		}
		let writable = await ownsProxyWriter(dir) || ([...sessions.values()].some(session => session.build && session.readerChecked === undefined) &&
			await acquireProxyWriter(dir));
		if (writable && initialized !== dir) {
			try {
				await cleanInterruptedJobs(dir);
				initialized = dir;
			} catch (error) {
				if (!(error instanceof ProxyWriterLost)) throw error;
				writable = false;
			}
		}
		if (writable) for (const session of sessions.values()) {
			if (!session.build || session.stopped) continue;
			if (session.readerChecked !== undefined) session.done.clear();
			session.readerChecked = undefined;
			session.readerPending = false;
		}
		const blocked = new Set<Session>();
		const builds = (session: Session) => writable && session.build && !session.stopped;
		const progress = (session: Session) => !session.build ? "off" : session.stopped ? "failed" : writable ? "preparing" : "readonly";
		while (!wiping && !isPaused()) {
			const entry = [...sessions.entries()].find(([, session]) => !blocked.has(session) &&
				(builds(session) || readerDue(session)) &&
				session.ids.some(id => !session.done.has(id)));
			if (!entry) break;
			const [sessionId, session] = entry;
			const id = session.ids.find(id => !session.done.has(id))!;
			const job: Job = { session, id, revision: session.revisions.get(id) ?? 0, controller: new AbortController() };
			active = job;
			const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(20 * 60_000)]);
			try {
				session.bytes = (await files(dir)).reduce((n, file) => n + file.stat.size, 0);
				const file = await sourcePath(session.project, id).catch(() => undefined);
				const source = file ? { file, ...await fingerprint(file) } : undefined;
				job.source = source;
				signal.throwIfAborted();
				let info = source && await cached(dir, source, builds(session));
				if (source && !info && builds(session)) {
					await requireProxyWriter(dir);
					const { encoders, cuda } = await detectEncoders(dir, signal);
					if (!encoders || (!encoders.length && !session.software)) {
						send(session, encoders ? "software" : capabilities?.error ? "failed" : "missing");
						blocked.add(session);
						continue;
					}
					if (!failures.has(source.key)) {
						send(session, "preparing");
						info = await prepare(dir, source, session.software, encoders, cuda, signal);
						session.failedInRow = 0;
					}
				}
				if (!signal.aborted && usesJob(session, job)) {
					session.done.add(id);
					if (info || builds(session)) session.diskBlocked.delete(id);
					const previous = session.written.get(id);
					if (previous && previous !== info?.key) {
						session.written.delete(id);
						send(session, progress(session), { evicted: previous });
					}
					if (info) {
						session.written.set(id, info.key);
						send(session, progress(session), { media: { id, info } });
					}
				}
			} catch (error) {
				if (error instanceof ProxyWriterLost) {
					job.controller.abort();
					writable = false;
					initialized = undefined;
					continue;
				}
				if (job.controller.signal.aborted || !usesJob(session, job)) continue;
				const key = job.source?.key;
				if (error instanceof EncoderBusy) {
					// A remembered result keeps its time, which the timer is set for.
					if (!capabilities?.busy || capabilities.expiresAt <= Date.now()) {
						capabilities = { encoders: [], expiresAt: Date.now() + 30_000, busy: true };
					}
					blocked.add(session);
					retryLater();
					continue;
				}
				if (error instanceof LowDisk) session.diskBlocked.add(id);
				else if (key) {
					session.diskBlocked.delete(id);
					if (failures.size >= 1024) failures.delete(failures.values().next().value!);
					failures.add(key);
					if (!failedBefore.has(key) && ++session.failedInRow >= failureLimit) session.stopped = errorText(error);
				}
				session.done.add(id);
			} finally {
				active = undefined;
				if (sessions.get(sessionId) === session) {
					sessions.delete(sessionId);
					sessions.set(sessionId, session);
				}
			}
		}
		const bytes = (await files(dir)).reduce((n, file) => n + file.stat.size, 0);
		for (const session of sessions.values()) {
			const complete = session.ids.every(id => session.done.has(id));
			if (!builds(session) && readerDue(session)) {
				session.readerChecked ??= Date.now();
				session.readerPending = !complete;
			}
			if (blocked.has(session)) continue;
			session.bytes = bytes;
			if (complete) {
				const result = session.written.size ? "ready" : "empty";
				send(session, !session.build ? "off" : session.stopped ? "failed" : !writable ? "readonly" : session.diskBlocked.size ? "disk" : result);
			}
		}
	} catch (error) { console.error("Proxy preparation failed", error); }
	finally {
		running = false;
		idle.resolve();
		if (needsPump) { needsPump = false; void pump(); }
	}
}
export async function clearProxies() {
	const dir = await proxyDirectory();
	if (!dir || !await acquireProxyWriter(dir)) return false;
	if (wiping) return true;
	wiping = true;
	try {
		active?.controller.abort();
		await idle?.promise;
		await requireProxyWriter(dir);
		for (const entry of await files(dir)) {
			const key = entry.name.slice(0, -4);
			for (const ext of [".mp4", ".json"]) {
				const file = path.join(dir, key + ext);
				if (await proxyFile(file)) {
					await requireProxyWriter(dir);
					await fs.rm(file);
				}
			}
			notifyEvicted(key);
		}
		for (const session of sessions.values()) {
			session.ids = [];
			session.done.clear();
			session.diskBlocked.clear();
			session.written.clear();
			session.bytes = 0;
			send(session, "off");
		}
		return true;
	} catch (error) {
		if (error instanceof ProxyWriterLost) return false;
		throw error;
	} finally { wiping = false; }
}
export async function proxyPath(key: string) {
	if (!cachedProxyKey.test(key) || !key.endsWith("-" + proxyProfile)) return;
	const dir = await proxyDirectory();
	if (!dir) return;
	const video = path.join(dir, key + ".mp4");
	const [entry, metadata] = await Promise.all([proxyFile(video), proxyFile(path.join(dir, key + ".json"))]);
	if (!entry || !metadata) return;
	if (Date.now() - entry.mtimeMs > 60_000 && await ownsProxyWriter(dir)) {
		const now = new Date();
		void fs.utimes(video, now, now).catch(() => {});
	}
	return video;
}
