// Server part of ducking: read the voice audio (ffmpeg, mono 16 kHz) and turn it into volume keyframes
// for the music element. Node only: used by the agent API route and the duck CLI.
import { execFile } from "node:child_process";
import path from "node:path";
import { RetrievalError, toolsFromEnv } from "@/retrieval/server";
import { type Segment, type VolumeKeyframe, duckKeyframes, frameLevels, mergeSegments, speechSegments } from "./duck";

const SAMPLE_RATE = 16000;

/** Mono samples of `file` from `start` for `duration` seconds. */
export type PcmReader = (file: string, start: number, duration: number) => Promise<Float32Array>;

export function ffmpegPcmReader(env: Record<string, string | undefined> = process.env): PcmReader {
	const tools = toolsFromEnv(env);
	return (file, start, duration) =>
		new Promise((resolve, reject) => {
			const args = [...tools.ffmpeg.slice(1), "-hide_banner", "-loglevel", "error", "-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", file, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-"];
			execFile(tools.ffmpeg[0], args, { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
				if (error) {
					const code = (error as NodeJS.ErrnoException).code;
					reject(new RetrievalError(code === "ENOENT" ? "ffmpeg was not found. Install it or set BOPENCUT_FFMPEG." : `ffmpeg failed: ${String(stderr).trim().split(/\r?\n/).slice(-2).join(" ")}`));
					return;
				}
				const bytes = new Uint8Array(stdout.byteLength - (stdout.byteLength % 4));
				bytes.set(stdout.subarray(0, bytes.length));
				resolve(new Float32Array(bytes.buffer));
			});
		});
}

export type DuckVoice = { path: string; start: number; trimStart?: number; duration: number };
export type DuckRequest = {
	music: { duration: number; start?: number; baseDb?: number };
	voices: DuckVoice[];
	amountDb?: number;
	attack?: number;
	release?: number;
	thresholdDb?: number;
};

const finite = (v: unknown, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

export function validateDuck(input: unknown): { ok: true; value: DuckRequest } | { ok: false; error: string } {
	const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const music = body.music as Record<string, unknown> | undefined;
	if (!music || !finite(music.duration, 0.01, 6 * 3600)) return { ok: false, error: "music.duration (seconds) is required" };
	if (music.start !== undefined && !finite(music.start, 0)) return { ok: false, error: "music.start must be seconds" };
	if (music.baseDb !== undefined && !finite(music.baseDb, -60, 20)) return { ok: false, error: "music.baseDb must be dB" };
	if (!Array.isArray(body.voices) || !body.voices.length || body.voices.length > 50) return { ok: false, error: "voices: 1 to 50 items" };
	for (const v of body.voices as Record<string, unknown>[]) {
		if (!v || typeof v.path !== "string" || !finite(v.start, 0) || !finite(v.duration, 0.01, 6 * 3600) || (v.trimStart !== undefined && !finite(v.trimStart, 0))) {
			return { ok: false, error: "each voice needs path, start and duration (seconds)" };
		}
	}
	if (body.amountDb !== undefined && !finite(body.amountDb, -60, 0)) return { ok: false, error: "amountDb must be from -60 to 0" };
	if (body.attack !== undefined && !finite(body.attack, 0, 5)) return { ok: false, error: "attack must be from 0 to 5 s" };
	if (body.release !== undefined && !finite(body.release, 0, 10)) return { ok: false, error: "release must be from 0 to 10 s" };
	if (body.thresholdDb !== undefined && !finite(body.thresholdDb, -90, 0)) return { ok: false, error: "thresholdDb must be from -90 to 0" };
	return { ok: true, value: body as unknown as DuckRequest };
}

/** Speech segments of every voice, in music-element time, and the volume keyframes for the music. */
export async function computeDuck(request: DuckRequest, { filesRoot, reader }: { filesRoot: string; reader: PcmReader }): Promise<{ segments: Segment[]; keyframes: VolumeKeyframe[] }> {
	const root = path.resolve(filesRoot);
	const musicStart = request.music.start ?? 0;
	const all: Segment[] = [];
	for (const voice of request.voices) {
		const file = path.resolve(root, voice.path);
		if (!file.startsWith(root + path.sep)) throw new RetrievalError(`voice path outside AGENT_FILES_ROOT: ${voice.path}`);
		const samples = await reader(file, voice.trimStart ?? 0, voice.duration);
		const local = speechSegments(frameLevels(samples, SAMPLE_RATE), request.thresholdDb === undefined ? {} : { thresholdDb: request.thresholdDb });
		for (const s of local) all.push({ start: s.start + voice.start - musicStart, end: Math.min(s.end, voice.duration) + voice.start - musicStart });
	}
	const segments = mergeSegments(all, 0).filter((s) => s.end > 0 && s.start < request.music.duration);
	const keyframes = duckKeyframes(segments, { duration: request.music.duration, baseDb: request.music.baseDb, amountDb: request.amountDb, attack: request.attack, release: request.release });
	return { segments: segments.map((s) => ({ start: Math.round(s.start * 1000) / 1000, end: Math.round(s.end * 1000) / 1000 })), keyframes };
}

/** Body of POST /api/agent/duck; see DuckRequest. Returns `{segments, keyframes}`. */
export async function handleDuck(body: unknown, { filesRoot, reader = ffmpegPcmReader() }: { filesRoot: string; reader?: PcmReader }): Promise<{ status: number; body: unknown }> {
	const request = validateDuck(body);
	if (!request.ok) return { status: 400, body: { error: request.error } };
	try {
		return { status: 200, body: await computeDuck(request.value, { filesRoot, reader }) };
	} catch (error) {
		if (error instanceof RetrievalError) return { status: 502, body: { error: error.message } };
		throw error;
	}
}
