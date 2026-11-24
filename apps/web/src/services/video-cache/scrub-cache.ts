import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from "mediabunny";
import { getDecodableVideoTrack } from "@/media/video-probe";
import { fitSurfaceSize } from "@/services/renderer/scale";
import { waitWithAbort } from "@/utils/abort";

const SOURCE_LIMIT = 6;
const SOURCE_BYTES = 32 * 1024 * 1024;
const SOURCE_READ_CACHE = 8 * 1024 * 1024;
const FRAME_LIMIT = 16;
const FRAME_BYTES = 8 * 1024 * 1024;
const FRAME_DIMENSION = 640;
const JOB_LIMIT = 2;
const DETAIL_DWELL_MS = 140;
const DETAIL_WINDOW_SECONDS = 2;
const DETAIL_SAMPLES_PER_SECOND = 20;
const DETAIL_DIMENSION = 320;
const DETAIL_FRAME_LIMIT = 80;
const DETAIL_FRAME_BYTES = 18 * 1024 * 1024;

type Frame = {
	canvas: OffscreenCanvas;
	timestamp: number;
	sourceWidth: number;
	sourceHeight: number;
};

type TimeRange = { start: number; end: number };
type Entry = TimeRange & { source: Source; frame: Frame | null; bytes: number };
type FramePool = { entries: Set<Entry>; bytes: number; maxCount: number; maxBytes: number };
type Job = { controller: AbortController; range?: TimeRange };
type Source = {
	input: Input;
	track: Promise<InputVideoTrack>;
	bytes: number;
	job?: Job;
	detailWindow?: TimeRange & { since: number; attempted?: boolean };
};

function contains({ start, end }: TimeRange, time: number): boolean {
	return start <= time && time < end;
}

function rasterize(sample: VideoSample, track: InputVideoTrack, dimension: number): Frame | null {
	const sourceWidth = track.displayWidth;
	const sourceHeight = track.displayHeight;
	const { width, height } = fitSurfaceSize(sourceWidth, sourceHeight, dimension);
	const canvas = new OffscreenCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) return null;
	sample.drawWithFit(context, { fit: "fill", rotation: track.rotation });
	return { canvas, timestamp: sample.timestamp, sourceWidth, sourceHeight };
}

async function readSamples(
	track: InputVideoTrack,
	times: number[],
	signal: AbortSignal,
	use: (sample: VideoSample | null, time: number) => void,
): Promise<void> {
	const samples = new VideoSampleSink(track).samplesAtTimestamps(times);
	try {
		for (const time of times) {
			await waitWithAbort(samples.next().then(({ value }) => {
				try {
					signal.throwIfAborted();
					use(value ?? null, time);
				} finally {
					value?.close();
				}
			}), signal);
		}
	} finally {
		await samples.return();
	}
}

/** Interactive preview cache for input metadata and small rasterized video frames. */
export class ScrubVideoCache {
	private sources = new Map<File, Source>();
	private keys: FramePool = { entries: new Set(), bytes: 0, maxCount: FRAME_LIMIT, maxBytes: FRAME_BYTES };
	private details: FramePool = { entries: new Set(), bytes: 0, maxCount: DETAIL_FRAME_LIMIT, maxBytes: DETAIL_FRAME_BYTES };
	private pinned = new Set<Entry>();
	private reads = new Map<Source, Set<number>>();
	private wanted = new Map<Source, Set<number>>();
	private sourceBytes = 0;
	private jobs = 0;
	private detailRunning = false;
	private onReady?: () => void;

	constructor(private clock = () => performance.now()) {}

	getFrameAt(file: File, time: number): Frame | null {
		const source = this.getSource(file);
		if (!source) return null;
		let times = this.reads.get(source);
		if (!times) this.reads.set(source, times = new Set());
		if (times.size < FRAME_LIMIT) times.add(time);
		const detail = this.find(this.details, source, time);
		const pool = detail?.frame ? this.details : this.keys;
		const entry = detail?.frame ? detail : this.find(this.keys, source, time);
		if (!entry) return null;
		pool.entries.delete(entry);
		pool.entries.add(entry);
		this.pinned.add(entry);
		return entry.frame;
	}

	finishFrame(onReady?: () => void): void {
		this.pinned.clear();
		if (!onReady) {
			this.reads.clear();
			return;
		}
		this.onReady = onReady;
		this.wanted = this.reads;
		this.reads = new Map();
		const now = this.clock();
		for (const source of this.sources.values()) {
			const { job, detailWindow } = source;
			const times = this.wanted.get(source);
			const time = times?.size === 1 ? times.values().next().value : undefined;
			if (time === undefined) {
				source.detailWindow = undefined;
			} else if (!detailWindow || !contains(detailWindow, time)) {
				const start = Math.floor(time / DETAIL_WINDOW_SECONDS) * DETAIL_WINDOW_SECONDS;
				source.detailWindow = { start, end: start + DETAIL_WINDOW_SECONDS, since: now };
			}
			const range = job?.range;
			if (job && (!times || (range && ![...times].some((time) => contains(range, time))))) {
				job.controller.abort();
			}
		}
		this.pump();
	}

	stop(): void {
		if (!this.onReady) return;
		this.onReady = undefined;
		this.wanted.clear();
		this.finishFrame();
		for (const source of this.sources.values()) {
			source.detailWindow = undefined;
			source.job?.controller.abort();
		}
	}

	clear(): void {
		this.stop();
		this.finishFrame();
		for (const [file, source] of this.sources) this.dropSource(file, source);
	}

	private getSource(file: File): Source | undefined {
		const existing = this.sources.get(file);
		if (existing) {
			this.sources.delete(file);
			this.sources.set(file, existing);
			return existing;
		}
		// BlobSource reads bounded slices. Charge an allowance for container metadata as well.
		const bytes = Math.min(file.size, SOURCE_READ_CACHE) + 512 * 1024;
		while (this.sources.size >= SOURCE_LIMIT || this.sourceBytes + bytes > SOURCE_BYTES) {
			const oldest = [...this.sources].find(([, source]) => !this.reads.has(source));
			if (!oldest) return;
			this.dropSource(...oldest);
		}
		const input = new Input({
			source: new BlobSource(file, { maxCacheSize: SOURCE_READ_CACHE }),
			formats: ALL_FORMATS,
		});
		const track = getDecodableVideoTrack(input);
		void track.catch(() => {});
		const source = { input, track, bytes };
		this.sources.set(file, source);
		this.sourceBytes += bytes;
		return source;
	}

	private dropSource(file: File, source: Source): void {
		source.job?.controller.abort();
		source.input.dispose();
		this.sources.delete(file);
		this.wanted.delete(source);
		this.sourceBytes -= source.bytes;
		for (const pool of [this.keys, this.details]) {
			for (const entry of pool.entries) {
				if (entry.source === source) this.dropFrame(pool, entry);
			}
		}
	}

	private find(pool: FramePool, source: Source, time: number): Entry | undefined {
		for (const entry of pool.entries) {
			if (entry.source === source && contains(entry, time)) return entry;
		}
	}

	private dropFrame(pool: FramePool, entry: Entry): void {
		pool.entries.delete(entry);
		pool.bytes -= entry.bytes;
		if (entry.frame) {
			entry.frame.canvas.width = 0;
			entry.frame.canvas.height = 0;
		}
	}

	private store(pool: FramePool, source: Source, range: TimeRange, frame: Frame | null): boolean {
		const bytes = frame ? frame.canvas.width * frame.canvas.height * 4 : 0;
		while (pool.entries.size >= pool.maxCount || pool.bytes + bytes > pool.maxBytes) {
			const oldest = [...pool.entries].find((entry) => !this.pinned.has(entry));
			if (!oldest) {
				if (frame) frame.canvas.width = 0;
				return false;
			}
			this.dropFrame(pool, oldest);
		}
		pool.entries.add({ ...range, source, frame, bytes });
		pool.bytes += bytes;
		return true;
	}

	private pump(): void {
		for (const [source, times] of this.wanted) {
			if (this.jobs >= JOB_LIMIT) return;
			if (source.job) continue;
			const time = [...times].find((time) => !this.find(this.keys, source, time));
			if (time === undefined) continue;
			const job: Job = { controller: new AbortController() };
			this.startJob(source, job, () => this.decodeKey(source, time, job));
		}
		if (this.jobs < JOB_LIMIT && !this.detailRunning) this.pumpDetail();
	}

	private startJob(source: Source, job: Job, run: () => Promise<void>): void {
		source.job = job;
		this.jobs++;
		void run().finally(() => {
			source.job = undefined;
			this.jobs--;
			this.pump();
		});
	}

	private pumpDetail(): void {
		const now = this.clock();
		for (const [source, times] of this.wanted) {
			const window = source.detailWindow;
			const time = times.values().next().value;
			if (source.job || !window || window.attempted || time === undefined || now - window.since < DETAIL_DWELL_MS) continue;
			const key = this.find(this.keys, source, time);
			// Keep speculative work within roughly one long GOP of the moving pointer.
			if (!key?.frame || time - key.frame.timestamp > 9) continue;
			const points: number[] = [];
			for (let i = window.start * DETAIL_SAMPLES_PER_SECOND; i < window.end * DETAIL_SAMPLES_PER_SECOND; i++) {
				const point = i / DETAIL_SAMPLES_PER_SECOND;
				if (point >= 0 && !this.find(this.details, source, point)) points.push(point);
			}
			if (!points.length) continue;
			window.attempted = true;
			const job = { controller: new AbortController(), range: window };
			this.detailRunning = true;
			this.startJob(source, job, async () => {
				const { signal } = job.controller;
				try {
					const track = await waitWithAbort(source.track, signal);
					await readSamples(track, points, signal, (sample, start) => {
						const end = (Math.round(start * DETAIL_SAMPLES_PER_SECOND) + 1) / DETAIL_SAMPLES_PER_SECOND;
						const range = { start, end };
						const frame = sample && rasterize(sample, track, DETAIL_DIMENSION);
						if (this.store(this.details, source, range, frame) && frame &&
							[...(this.wanted.get(source) ?? [])].some((time) => contains(range, time))) {
							this.onReady?.();
						}
					});
				} catch {
					// The keyframe stays available if an intermediate decode fails.
				} finally {
					this.detailRunning = false;
				}
			});
			return;
		}
	}

	private async decodeKey(source: Source, time: number, job: Job): Promise<void> {
		const { signal } = job.controller;
		let range: TimeRange = { start: time, end: time + 0.05 };
		try {
			const track = await waitWithAbort(source.track, signal);
			const packets = new EncodedPacketSink(track);
			const key = await waitWithAbort((async () =>
				await packets.getKeyPacket(time, { verifyKeyPackets: true })
				?? await packets.getFirstKeyPacket({ verifyKeyPackets: true })
			)(), signal);
			if (!key) throw new Error("No video keyframe");
			const next = await waitWithAbort(packets.getNextKeyPacket(key, { metadataOnly: true }), signal);
			const keyRange = {
				start: key.timestamp > time ? -Infinity : key.timestamp,
				end: next?.timestamp ?? Infinity,
			};
			if (!contains(keyRange, time)) throw new Error("Invalid keyframe order");
			range = job.range = keyRange;
			if (![...(this.wanted.get(source) ?? [])].some((time) => contains(range, time))) return;

			// The timestamp iterator can decode the key packet without walking the GOP.
			await readSamples(track, [key.timestamp], signal, (sample) => {
				const frame = sample && rasterize(sample, track, FRAME_DIMENSION);
				if (!this.store(this.keys, source, range, frame)) this.wanted.get(source)?.delete(time);
				else if (frame) this.onReady?.();
			});
		} catch {
			if (!signal.aborted && !this.store(this.keys, source, range, null)) this.wanted.get(source)?.delete(time);
		}
	}
}
