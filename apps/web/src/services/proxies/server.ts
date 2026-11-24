import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runBackgroundProcess } from "@/retrieval/process";
import { toolsFromEnv } from "@/retrieval/server";
import { dataRoot, projectDir, safeId } from "@/services/storage/server/files";
import type { ProxyInfo, ProxyUpdate } from "./mapping";

const profile = "p1-v1";
const chunk = 64 * 1024;
function byteSetting(value: string | undefined, fallback: number) {
	const bytes = Number(value);
	return value && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : fallback;
}
const reserve = () => byteSetting(process.env.BOPENCUT_PROXY_FREE_BYTES, 5_000_000_000);
const limit = () => byteSetting(process.env.BOPENCUT_PROXY_LIMIT_BYTES, 8_000_000_000);
const directory = () => path.join(dataRoot(), "proxies");
const keyPattern = /^[a-f0-9]{64}-p1-v1$/;
class LowDisk extends Error {}
export async function fingerprint(file: string) {
	const input = await fs.open(file, "r");
	try {
		const { size } = await input.stat();
		const hash = createHash("sha256").update(String(size));
		for (const start of [0, Math.max(0, Math.floor((size - chunk) / 2)), Math.max(0, size - chunk)]) {
			const bytes = Buffer.alloc(Math.min(size, chunk));
			const { bytesRead } = await input.read(bytes, 0, bytes.length, start);
			hash.update(bytes.subarray(0, bytesRead));
		}
		return { key: hash.digest("hex") + "-" + profile, size };
	} finally { await input.close(); }
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
	streams: { width: number; height: number; pix_fmt: string; time_base: string; duration?: string; sample_aspect_ratio?: string; tags?: { alpha_mode?: string }; side_data_list?: { rotation?: number }[] }[];
	frames: { best_effort_timestamp: number; key_frame: number; pict_type: string }[];
};

function command() { return toolsFromEnv().ffmpeg; }
function run(args: string[], signal: AbortSignal) {
	const [exe, ...leading] = command();
	return runBackgroundProcess(exe, [...leading, "-nostdin", ...args], signal, directory());
}
async function encode(args: string[], output: string, signal: AbortSignal) {
	const stall = new AbortController();
	let previousSize = -1;
	let progress = Date.now();
	const monitor = setInterval(() => {
		void fs.stat(output).then(({ size }) => {
			if (size !== previousSize) { previousSize = size; progress = Date.now(); }
		}).catch(() => {}).finally(() => {
			if (Date.now() - progress > 30_000) stall.abort();
		});
	}, 1_000);
	try { await run(args, AbortSignal.any([signal, stall.signal])); }
	finally { clearInterval(monitor); }
}
async function probe(file: string, signal: AbortSignal): Promise<Probe> {
	const [exe] = command();
	const suffix = process.platform === "win32" ? ".exe" : "";
	const ffprobe = path.isAbsolute(exe) ? path.join(path.dirname(exe), "ffprobe" + suffix) : "ffprobe" + suffix;
	const result = await runBackgroundProcess(ffprobe, ["-v", "error", "-select_streams", "v",
		"-show_frames", "-show_streams", "-show_entries",
		"frame=best_effort_timestamp,key_frame,pict_type:stream=width,height,pix_fmt,time_base,duration,sample_aspect_ratio:stream_tags=alpha_mode:stream_side_data=rotation",
		"-of", "json", file], signal, directory());
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
async function files() {
	const entries = await fs.readdir(directory()).catch(() => []);
	return Promise.all(entries.filter((name) => name.endsWith(".mp4") && keyPattern.test(name.slice(0, -4)))
		.map(async (name) => {
			const video = await fs.stat(path.join(directory(), name));
			const sidecar = await fs.stat(path.join(directory(), name.replace(/\.mp4$/, ".json"))).catch(() => null);
			return { name, stat: { size: video.size + (sidecar?.size ?? 0), mtimeMs: video.mtimeMs } };
		}));
}
async function cleanInterruptedJobs() {
	const names = new Set(await fs.readdir(directory()));
	for (const name of names) {
		const match = /^([a-f0-9]{64}-p1-v1)\.(mp4|json)$/.exec(name);
		if (/^\.job-[a-f0-9-]{36}\.mp4(?:\.json)?$/.test(name) ||
			(match && !names.has(match[1] + (match[2] === "mp4" ? ".json" : ".mp4")))) {
			await fs.rm(path.join(directory(), name), { force: true }).catch(() => {});
		}
	}
}
export async function ensureProxySpace(bytes: number, keep?: string, alreadyWritten = 0): Promise<number> {
	const available = await fs.statfs(directory());
	if (available.bavail * available.bsize - Math.max(0, bytes - alreadyWritten) < reserve()) throw new LowDisk();
	const entries = await files();
	let used = entries.reduce((n, f) => n + f.stat.size, 0);
	for (const entry of entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
		if (used + bytes <= limit()) break;
		if (entry.name === keep + ".mp4") continue;
		await fs.rm(path.join(directory(), entry.name), { force: true }).catch(() => {});
		if (await fs.stat(path.join(directory(), entry.name)).catch(() => null)) continue;
		await fs.rm(path.join(directory(), entry.name.replace(/\.mp4$/, ".json")), { force: true });
		used -= entry.stat.size;
	}
	if (used + bytes > limit()) throw new LowDisk();
	return used;
}

async function prepare(file: string, software: boolean, encoders: string[], signal: AbortSignal): Promise<ProxyInfo | undefined> {
	const { key, size } = await fingerprint(file);
	const video = path.join(directory(), key + ".mp4");
	const metadata = path.join(directory(), key + ".json");
	if (await fs.stat(video).catch(() => null)) {
		const info = await fs.readFile(metadata, "utf8").then(JSON.parse).catch(() => null);
		if (info) { const now = new Date(); await fs.utimes(video, now, now).catch(() => {}); return info; }
	}
	await ensureProxySpace(0);
	const source = await probe(file, signal);
	// The editor and FFmpeg can select different tracks when there is more than one.
	if (source.streams.length !== 1) return;
	const stream = source.streams[0];
	const pts = timestamps(source);
	if (!stream || !pts || stream.tags?.alpha_mode === "1" || /^(yuva|gbrap|rgba|bgra|argb|abgr|ya|pal)/.test(stream.pix_fmt)) return;
	if (stream.sample_aspect_ratio && !["1:1", "N/A"].includes(stream.sample_aspect_ratio)) return;
	const duration = Number(stream.duration) || pts.at(-1)! - pts[0];
	if (duration < 2) return;
	if (Math.min(stream.width, stream.height) <= 540 && shortGop(source.frames)) return;
	const rotation = stream.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? 0;
	if (rotation % 90) return;
	const [width, height] = Math.abs(rotation % 180) ? [stream.height, stream.width] : [stream.width, stream.height];
	const scale = Math.min(1, 960 / Math.max(width, height), 540 / Math.min(width, height));
	const w = Math.max(2, Math.round(width * scale / 2) * 2);
	const h = Math.max(2, Math.round(height * scale / 2) * 2);
	const temp = path.join(directory(), ".job-" + randomUUID() + ".mp4");
	const sidecar = temp + ".json";
	const estimate = Math.min(limit(), Math.ceil(duration * 650_000 + pts.length * 48 + 4096));
	const used = await ensureProxySpace(estimate);
	const free = await fs.statfs(directory());
	const maxBytes = Math.floor(Math.min(limit() - used, free.bavail * free.bsize - reserve()));
	if (maxBytes < 1024) throw new LowDisk();
	try {
		let success = false;
		for (const encoder of [...encoders, ...(software ? ["libx264"] : [])]) {
			const hardware = encoder === "h264_nvenc" ? [["-hwaccel", "cuda"], []] : encoder === "libx264" ? [[]] : [["-hwaccel", "auto"], []];
			for (const decode of hardware) {
				const quality = encoder === "h264_nvenc" ? ["-preset", "p4", "-rc", "vbr", "-cq", "25", "-b:v", "0"]
					: encoder === "libx264" ? ["-preset", "ultrafast", "-crf", "24"] : ["-b:v", "4800k"];
				quality.push("-maxrate", "5200k", "-bufsize", "5200k");
				try {
					await encode(["-v", "error", "-y", ...decode, "-i", file, "-map", "0:v:0", "-an", "-sn", "-dn",
						"-vf", "scale=" + w + ":" + h + ":flags=lanczos,setsar=1", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
						"-c:v", encoder, ...quality, "-g", encoder === "h264_nvenc" ? "0" : "1", "-bf", "0", "-fs", String(maxBytes), "-movflags", "+faststart", temp], temp, signal);
					success = true;
					break;
				} catch { signal.throwIfAborted(); }
			}
			if (success) break;
		}
		if (!success) throw new Error("No working proxy encoder");
		const stat = await fs.stat(temp);
		if (stat.size >= maxBytes) throw new LowDisk();
		const output = await probe(temp, signal);
		const proxy = timestamps(output);
		// A constant timestamp offset is fine. Any drift, reordering or duplicated sample disables the proxy.
		if (!proxy || proxy.length !== pts.length || output.frames.some(f => !f.key_frame || f.pict_type === "B") ||
			output.streams[0]?.width !== w || output.streams[0]?.height !== h ||
			proxy.some((t, i) => Math.abs(t - proxy[0] - (pts[i] - pts[0])) > 0.002) ||
			(await fingerprint(file)).key !== key) return;
		const info = { key, width, height, source: pts, proxy, size, duration, frameCount: pts.length };
		const serialized = JSON.stringify(info);
		await ensureProxySpace(stat.size + Buffer.byteLength(serialized), key, stat.size);
		await fs.writeFile(sidecar, serialized);
		signal.throwIfAborted();
		await fs.rename(temp, video);
		try {
			signal.throwIfAborted();
			await fs.rename(sidecar, metadata);
		} catch (error) {
			await fs.rm(video, { force: true });
			throw error;
		}
		return info;
	} finally {
		await Promise.all([temp, sidecar].map(file => fs.rm(file, { force: true }).catch(() => {})));
	}
}

type Session = { project: string; ids: string[]; software: boolean; enabled?: boolean; paused: boolean; send: (update: ProxyUpdate) => void; done: Set<string> };
const sessions = new Map<string, Session>();
const failures = new Set<string>();
let active: { session: Session; media: string; controller: AbortController } | undefined;
let running = false;
let needsPump = false;
let initialized = false;
let wiping = false;
let idle: PromiseWithResolvers<void> | undefined;
let encoderProbe: Promise<string[] | null> | undefined;
export function updateSession(id: string, changes: Pick<Partial<Session>, "ids" | "paused">, replaced: string[] = []) {
	const session = sessions.get(id);
	if (!session) return;
	Object.assign(session, changes);
	for (const id of session.done) if (!session.ids.includes(id) || replaced.includes(id)) session.done.delete(id);
	if (session.paused || (active?.session === session &&
		(!session.ids.includes(active.media) || replaced.includes(active.media)))) active?.controller.abort();
	void pump();
}
export function openSession(id: string, session: Omit<Session, "done">) {
	const entry = { ...session, done: new Set<string>() };
	sessions.set(id, entry);
	if (entry.paused) active?.controller.abort();
	void pump();
	return () => {
		if (sessions.get(id) !== entry) return;
		sessions.delete(id);
		if (active?.session === entry) active.controller.abort();
		void pump();
	};
}
async function pump() {
	if (wiping) return;
	if (running) { needsPump = true; return; }
	running = true;
	idle = Promise.withResolvers<void>();
	try {
		await fs.mkdir(directory(), { recursive: true });
		if (!initialized) {
			initialized = true;
			await cleanInterruptedJobs();
		}
		encoderProbe ??= run(["-hide_banner", "-encoders"], AbortSignal.timeout(10_000))
			.then(async ({ stdout }) => {
				const available: string[] = [];
				for (const encoder of ["h264_nvenc", "h264_qsv", "h264_amf"]) {
					if (!stdout.includes(encoder)) continue;
					try {
						await run(["-v", "error", "-f", "lavfi", "-i", "color=s=128x128", "-frames:v", "1",
							"-c:v", encoder, "-g", encoder === "h264_nvenc" ? "0" : "1", "-bf", "0", "-f", "null", "-"],
						AbortSignal.timeout(12_000));
						available.push(encoder);
					} catch {}
				}
				return available;
			})
			.catch(() => null);
		const encoders = await encoderProbe;
		for (const session of sessions.values()) {
			const bytes = (await files()).reduce((sum, entry) => sum + entry.stat.size, 0);
			const report = (state: ProxyUpdate["state"], media?: ProxyUpdate["media"]) =>
				session.send({ state, bytes, done: session.done.size, total: session.ids.length, media });
			if (!encoders) { report("missing"); continue; }
			if (session.enabled === false) { report("off"); continue; }
			if (!encoders.length && !session.software) { report("software"); continue; }
			if ([...sessions.values()].some(entry => entry.paused)) continue;
			let failed = false;
			for (;;) {
				if (wiping || [...sessions.values()].some(entry => entry.paused) || ![...sessions.values()].includes(session)) break;
				const id = session.ids.find(id => !session.done.has(id));
				if (!id) break;
				const controller = new AbortController();
				active = { session, media: id, controller };
				report("preparing");
				let failureKey: string | undefined;
				try {
					const file = await sourcePath(session.project, id);
					if (file) failureKey = (await fingerprint(file)).key + (session.software ? ":software" : ":hardware");
					const info = file && failureKey && !failures.has(failureKey)
						? await prepare(file, session.software, encoders, AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60_000)])) : undefined;
					if (controller.signal.aborted) break;
					session.done.add(id);
					if (info) report("preparing", { id, info });
				} catch (error) {
					if (controller.signal.aborted) break;
					if (error instanceof LowDisk) { report("disk"); failed = true; break; }
					if (failureKey) {
						if (failures.size >= 1024) failures.delete(failures.values().next().value!);
						failures.add(failureKey);
					}
					session.done.add(id);
				} finally { active = undefined; }
			}
			if (!failed && session.ids.every(id => session.done.has(id))) {
				session.send({ state: "ready", bytes: (await files()).reduce((n, e) => n + e.stat.size, 0), done: session.done.size, total: session.ids.length });
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
	if (wiping) return;
	wiping = true;
	try {
		active?.controller.abort();
		for (const session of sessions.values()) { session.enabled = false; session.done.clear(); }
		await idle?.promise;
		for (const entry of await files()) {
			await fs.rm(path.join(directory(), entry.name), { force: true }).catch(() => {});
			await fs.rm(path.join(directory(), entry.name.replace(/\.mp4$/, ".json")), { force: true });
		}
		for (const session of sessions.values()) session.send({ state: "off", bytes: 0, total: session.ids.length, done: 0 });
	} finally {
		wiping = false;
	}
}
export async function proxyPath(key: string) {
	if (!keyPattern.test(key)) return;
	const video = path.join(directory(), key + ".mp4");
	const [entry, metadata] = await Promise.all([
		fs.lstat(video).catch(() => null),
		fs.lstat(path.join(directory(), key + ".json")).catch(() => null),
	]);
	if (!entry?.isFile() || !metadata?.isFile()) return;
	if (Date.now() - entry.mtimeMs > 60_000) {
		const now = new Date();
		void fs.utimes(video, now, now).catch(() => {});
	}
	return video;
}
