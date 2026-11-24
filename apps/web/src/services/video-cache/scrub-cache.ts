import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, type InputVideoTrack, type VideoSample } from "mediabunny";
import { getDecodableVideoTrack } from "@/media/video-probe";
import { fitSurfaceSize } from "@/services/renderer/scale";
import { waitWithAbort } from "@/utils/abort";
import { VideoCursor } from "./service";
import { retiringSamples } from "./retiring-sink";

const SOURCE_LIMIT = 6;
const SOURCE_BYTES = 32 * 1024 * 1024;
const SOURCE_READ_CACHE = 8 * 1024 * 1024;
const FRAME_LIMIT = 16;
const FRAME_BYTES = 8 * 1024 * 1024;
const FRAME_DIMENSION = 640;
const JOB_LIMIT = 2;
const DETAIL_DIMENSION = 240;
const DETAIL_FRAME_LIMIT = 220;
const DETAIL_FRAME_BYTES = 27 * 1024 * 1024;
const LOOK_BEHIND = 6;

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
};
type Motion = {
	source: Source;
	target: number;
	start: number;
	at: number;
	readTo: number;
	fast: boolean;
	backfill: boolean;
	cursor?: VideoCursor;
	pending?: Promise<unknown>;
};
type ScrubTarget = { time: number; extreme: number; direction: number; run: number };
type Presentation = { run: number; timestamp: number; frame?: Frame };
const TARGET_JUMP_SECONDS = 0.75;
const REVERSAL_SECONDS = 0.05;
type ExactOptions = {
	getScale?: (source: { width: number; height: number }) => number;
	maxTextureDimension?: number;
	signal?: AbortSignal;
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
	const samples = retiringSamples(track, (sink) => sink.samplesAtTimestamps(times));
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
	private retiring = 0;
	private motion?: Motion;
	private lastTarget?: { source: Source; time: number };
	private presentations = new Map<object, Presentation>();
	private framePresentations = new Map<object, Presentation>();
	private targets?: WeakMap<object, ScrubTarget>;
	private settling = false;
	private missing = false;
	private retained = false;
	private exactRead?: { time: number; sample: ReturnType<VideoCursor["readAt"]> };
	private onReady?: () => void;

	get active(): boolean { return !!this.onReady; }
	get needsFrame(): boolean { return this.missing; }
	get isRetainingFrame(): boolean { return this.retained; }

	private readSource(file: File, time: number): Source | undefined {
		const source = this.getSource(file);
		if (!source) return;
		let times = this.reads.get(source);
		if (!times) this.reads.set(source, times = new Set());
		if (times.size < FRAME_LIMIT) times.add(time);
		return source;
	}

	getFrameAt(file: File, time: number, clip?: object): Frame | null {
		const source = this.readSource(file, time);
		if (!source) {
			this.missing = true;
			return null;
		}
		const previous = clip && this.presentations.get(clip);
		const target = clip ? this.recordTarget(clip, time) : undefined;
		const direction = target?.direction ?? 0;
		const detail = this.nearestDetail(source, time, direction < 0 ? 0.09 : 0.5)
			?? (direction < 0 ? this.followingDetail(source, time) : undefined);
		const pool = detail?.frame ? this.details : this.keys;
		const entry = detail?.frame ? detail : this.find(this.keys, source, time);
		let frame = entry?.frame ?? null;
		// A preceding keyframe cannot establish frame order in a backward drag.
		if (clip && !detail && direction <= 0 && frame && frame.timestamp < time) frame = null;
		const sameRun = previous && previous.run === target?.run;
		if (previous && (!frame || ((sameRun || !detail) && this.isOutOfOrder(previous.timestamp, frame.timestamp, direction)))) {
			frame = previous.frame?.canvas.width ? previous.frame : null;
			this.retained = true;
		}
		if (clip && target && frame) {
			if (previous && frame.timestamp === previous.timestamp &&
				!(detail && detail.frame === frame && contains(detail, time)) && frame.timestamp !== time) {
				this.retained = true;
			}
			// A held picture can stay visible across a seek without becoming this run's ordering reference.
			this.framePresentations.set(clip, {
				run: previous && frame === previous.frame ? previous.run : target.run,
				timestamp: frame.timestamp,
				frame,
			});
		}
		if (entry && frame === entry.frame) {
			pool.entries.delete(entry);
			pool.entries.add(entry);
			this.pinned.add(entry);
		}
		this.missing ||= !frame;
		return frame;
	}

	private isOutOfOrder(previous: number, candidate: number, direction: number): boolean {
		return direction < 0 ? candidate > previous : candidate < previous;
	}

	acceptExactFrame(file: File, time: number, clip: object, frame: Frame | null, recovering: boolean): void {
		const source = this.readSource(file, time);
		const target = this.recordTarget(clip, time);
		const previous = this.presentations.get(clip);
		if (!frame || (recovering && previous?.run === target.run &&
			this.isOutOfOrder(previous.timestamp, frame.timestamp, target.direction))) {
			this.missing = true;
			return;
		}
		const cached = source && this.find(this.details, source, frame.timestamp)?.frame;
		this.framePresentations.set(clip, {
			run: target.run,
			timestamp: frame.timestamp,
			frame: cached?.timestamp === frame.timestamp ? cached : undefined,
		});
	}

	private recordTarget(clip: object, time: number): ScrubTarget {
		const targets = this.targets ??= new WeakMap<object, ScrubTarget>();
		const previous = targets.get(clip);
		const delta = previous ? time - previous.time : 0;
		const jump = Math.abs(delta) > TARGET_JUMP_SECONDS;
		const previousDirection = previous?.direction ?? 0;
		const fromExtreme = time - (previous?.extreme ?? time);
		const reversal = previousDirection * fromExtreme < -REVERSAL_SECONDS;
		const restart = jump || reversal;
		const direction = restart || !previousDirection ? Math.sign(delta) : previousDirection;
		const extreme = restart || !previousDirection || direction * fromExtreme >= 0 ? time : previous!.extreme;
		const target = { time, extreme, direction, run: (previous?.run ?? 0) + Number(restart) };
		targets.set(clip, target);
		return target;
	}

	finishFrame(onReady?: () => void, presented = true): void {
		this.missing = false;
		this.retained = false;
		this.pinned.clear();
		if (!onReady) {
			this.reads.clear();
			this.framePresentations.clear();
			return;
		}
		this.settling = false;
		this.exactRead = undefined;
		this.motion?.cursor?.finishFrame();
		if (!presented) {
			this.framePresentations.clear();
		} else {
			this.presentations = this.framePresentations;
			this.framePresentations = new Map();
		}
		this.onReady = onReady;
		this.wanted = this.reads;
		this.reads = new Map();
		for (const source of this.sources.values()) {
			const { job } = source;
			const times = this.wanted.get(source);
			const range = job?.range;
			if (job && (!times || (range && ![...times].some((time) => contains(range, time))))) {
				job.controller.abort();
			}
		}
		this.updateMotion();
		this.pump();
	}

	async getExactFrameAt(file: File, time: number, options: ExactOptions, recovering = false): Promise<Frame | null> {
		const motion = this.motion;
		if (!motion || this.sources.get(file) !== motion.source) return null;
		if (recovering && (motion.pending || time < motion.readTo || !motion.cursor?.canAdvanceTo(time))) return null;
		this.settling = true;
		const { signal, getScale, maxTextureDimension = Infinity } = options;
		await waitWithAbort(Promise.resolve(motion.pending), signal);
		if (this.motion !== motion || !motion.cursor) return null;
		const track = await waitWithAbort(motion.source.track, signal);
		if (this.motion !== motion) return null;
		if (!this.exactRead) {
			const key = this.find(this.keys, motion.source, time);
			if (recovering && (!motion.cursor.canAdvanceTo(time) ||
				(time - motion.at >= 2 && !(key && contains(key, motion.at))))) return null;
			const window = key && contains(key, motion.at) ? 4 : 2;
			const sample = motion.cursor.readAt(time, recovering ? (value) => {
				motion.at = value.timestamp;
				this.storeDetail(motion.source, track, value);
			} : undefined, recovering ? Infinity : window).catch(() => null).finally(() => {
				if (motion.pending === sample) motion.pending = undefined;
			});
			if (recovering) motion.readTo = time;
			this.exactRead = { time, sample };
			motion.pending = sample;
		}
		if (this.exactRead.time !== time) return null;
		const sample = await waitWithAbort(this.exactRead.sample, signal);
		signal?.throwIfAborted();
		if (this.motion !== motion || !sample) return null;
		const scale = getScale?.({ width: track.displayWidth, height: track.displayHeight }) ?? 1;
		return motion.cursor.rasterize(sample, track, scale, maxTextureDimension);
	}

	stop(): void {
		this.targets = undefined;
		if (!this.onReady) return;
		this.onReady = undefined;
		this.settling = false;
		this.exactRead = undefined;
		this.lastTarget = undefined;
		this.closeMotion();
		this.presentations.clear();
		this.wanted.clear();
		this.finishFrame();
		for (const source of this.sources.values()) {
			source.job?.controller.abort();
		}
		for (const entry of this.details.entries) this.dropFrame(this.details, entry);
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
		if (this.motion?.source === source) this.closeMotion();
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

	private nearestDetail(source: Source, time: number, maxDistance = 0.5): Entry | undefined {
		let best: Entry | undefined;
		for (const entry of this.details.entries) {
			if (entry.source !== source || entry.start > time ||
				(time >= entry.end && time - entry.start > maxDistance)) continue;
			if (!best || entry.start > best.start) best = entry;
		}
		return best;
	}

	private storeDetail(source: Source, track: InputVideoTrack, sample: VideoSample): void {
		const range = { start: sample.timestamp, end: sample.timestamp + Math.max(sample.duration, 0.000001) };
		if (this.find(this.details, source, range.start)?.start === range.start) return;
		const frame = rasterize(sample, track, DETAIL_DIMENSION);
		if (frame && this.store(this.details, source, range, frame) &&
			this.motion && Math.abs(this.motion.target - range.start) <= 0.5) this.onReady?.();
	}

	private followingDetail(source: Source, time: number): Entry | undefined {
		let best: Entry | undefined;
		for (const entry of this.details.entries) {
			if (entry.source !== source || entry.start < time || entry.start - time > 0.2) continue;
			if (!best || entry.start < best.start) best = entry;
		}
		return best;
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
			const previous = new Set([...this.presentations.values()].map((presentation) => presentation.frame));
			const oldest = [...pool.entries].find((entry) => !this.pinned.has(entry) && (!entry.frame || !previous.has(entry.frame)));
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
		if (this.settling) return;
		const primaryRead = this.wanted.entries().next().value;
		for (const [source, times] of this.wanted) {
			if (this.jobs + Number(!!this.motion) + this.retiring >= JOB_LIMIT) break;
			if (source.job) continue;
			const primary = primaryRead?.[0] === source ? primaryRead[1].values().next().value : undefined;
			const keyTime = primary !== undefined && !this.find(this.keys, source, primary) && !this.find(this.details, source, primary)
				? primary
				: undefined;
			const time = [...times].find((time) => time !== primary && !this.find(this.details, source, time));
			if (time !== undefined && keyTime === undefined) {
				const job = { controller: new AbortController(), range: { start: time - 0.25, end: time + 0.25 } };
				this.startJob(source, job, () => this.decodeDetail(source, time, job));
				continue;
			}
			if (keyTime === undefined) continue;
			const job: Job = { controller: new AbortController() };
			this.startJob(source, job, () => this.decodeKey(source, keyTime, job));
		}
		this.advanceMotion();
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

	private closeMotion(replace = true): void {
		const motion = this.motion;
		this.motion = undefined;
		if (!motion?.cursor) return;
		this.retiring++;
		void Promise.allSettled([motion.pending, motion.cursor.dispose()]).then(() => {
			this.retiring--;
			if (replace && !this.motion) this.updateMotion();
			this.pump();
		});
	}

	private updateMotion(): void {
		if (this.settling) return;
		// Overlapping reads have independent keyframes and settle through exact decode.
		const request = this.wanted.entries().next().value;
		const time = request?.[1].values().next().value;
		if (!request || time === undefined) {
			this.closeMotion();
			this.lastTarget = undefined;
			return;
		}
		const [source] = request;
		const backward = this.lastTarget?.source === source && time < this.lastTarget.time;
		const fast = this.lastTarget?.source === source && time - this.lastTarget.time > 0.14;
		this.lastTarget = { source, time };
		const motion = this.motion;
		if (motion?.source === source) {
			const key = this.find(this.keys, source, time);
			const jump = time > motion.target && key && key.start - Math.max(motion.at, motion.readTo) > 0.75;
			if (!jump && (!backward || motion.at === -Infinity || time >= motion.start || this.nearestDetail(source, time, 0.045))) {
				motion.fast = fast || (time === motion.target && motion.fast);
				motion.target = time;
				return;
			}
		}
		this.closeMotion();
		if (this.jobs + this.retiring >= JOB_LIMIT) return;
		this.motion = { source, target: time, start: time, at: -Infinity, readTo: -Infinity, fast, backfill: backward };
	}

	private advanceMotion(): void {
		const motion = this.motion;
		if (!motion || motion.pending || this.settling || motion.readTo >= motion.target) return;
		const task = (async () => {
			const track = await motion.source.track;
			if (this.motion !== motion) return;
			if (!motion.cursor && motion.backfill) {
				const time = motion.target;
				const key = await new EncodedPacketSink(track).getKeyPacket(time, { verifyKeyPackets: true });
				if (this.motion !== motion) return;
				motion.start = Math.max(0, time - LOOK_BEHIND, key?.timestamp ?? 0);
			}
			const target = Math.max(motion.start, Math.min(motion.target, motion.readTo + 1.5));
			motion.readTo = target;
			const cursor = motion.cursor ??= new VideoCursor(track, true);
			let sliceStarted = performance.now();
			await cursor.readAt(target, (sample) => {
				if (this.motion !== motion) return;
				motion.at = sample.timestamp;
				if (motion.fast && motion.target - sample.timestamp > 0.65) return;
				this.storeDetail(motion.source, track, sample);
				// A burst of decoder output can otherwise rasterize an entire slice
				// through microtasks before the browser can process pointer input.
				if (performance.now() - sliceStarted >= 7) {
					return new Promise<void>((resolve) => setTimeout(() => {
						sliceStarted = performance.now();
						resolve();
					}, 0));
				}
			});
		})().catch(() => {
			if (this.motion === motion) this.closeMotion(false);
		}).finally(() => {
			motion.pending = undefined;
			this.pump();
		});
		motion.pending = task;
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

	private async decodeDetail(source: Source, time: number, job: Job): Promise<void> {
		const { signal } = job.controller;
		const failed = { start: time, end: time + 0.001 };
		try {
			const track = await waitWithAbort(source.track, signal);
			await readSamples(track, [time], signal, (sample) => {
				const frame = sample && rasterize(sample, track, DETAIL_DIMENSION);
				const range = frame && sample
					? { start: sample.timestamp, end: Math.max(time + 0.000001, sample.timestamp + sample.duration) }
					: failed;
				if (!this.store(this.details, source, range, frame)) this.wanted.get(source)?.delete(time);
				else if (frame) this.onReady?.();
			});
		} catch {
			if (!signal.aborted) this.store(this.details, source, failed, null);
		}
	}
}
