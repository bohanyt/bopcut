import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from "mediabunny";
import { getDecodableVideoTrack } from "@/media/video-probe";
import { videoSurfaceSize, type VideoFrame } from "./service";

const SOURCE_LIMIT = 6;
const SOURCE_BYTES = 32 * 1024 * 1024;
const READ_BYTES = 8 * 1024 * 1024;
const FRAME_LIMIT = 180;
const FRAME_BYTES = 128 * 1024 * 1024;

type Source = { input: Input; track: Promise<InputVideoTrack>; bytes: number };
type Entry = { source: Source; start: number; end: number; frame: VideoFrame; bytes: number };
type Options = {
	getScale: (size: { width: number; height: number }) => number;
	maxTextureDimension: number;
	signal?: AbortSignal;
};
type Cursor = {
	source: Source;
	clip: object;
	time: number;
	windowStart?: number;
	bounds?: Promise<{ start: number; end: number }>;
	end: number;
	start?: number;
	current?: VideoSample;
	next?: VideoSample;
	exhausted?: boolean;
	requested?: boolean;
	samples?: ReturnType<VideoSampleSink["samples"]>;
	work?: Promise<void>;
};

/** Exact source samples for paused ruler drags. Compositing uses the regular preview size. */
export class ExactScrubCache {
	private sources = new Map<File, Source>();
	private entries = new Set<Entry>();
	private pinned = new Set<Entry>();
	private bytes = 0;
	private sourceBytes = 0;
	private cursor?: Cursor;
	private retiring = new Set<Promise<void>>();
	private target?: { clip: object; time: number; previous?: number };
	private fill?: () => void;

	async getFrameAt(file: File, clip: object, time: number, options: Options): Promise<VideoFrame | null> {
		options.signal?.throwIfAborted();
		const source = this.open(file);
		const previous = this.target?.clip === clip ? this.target : undefined;
		if (time !== previous?.time) this.target = { clip, time, previous: previous?.time };
		const track = await source.track;
		options.signal?.throwIfAborted();
		if (this.sources.get(file) !== source) return null;
		const size = videoSurfaceSize(track.displayWidth, track.displayHeight, options.getScale({
			width: track.displayWidth, height: track.displayHeight,
		}), options.maxTextureDimension);
		let cursor = this.cursor;
		if (cursor && (cursor.source !== source || (cursor.clip !== clip && cursor.time !== time))) {
			this.retire(cursor);
			cursor = undefined;
		}
		const hit = this.find(source, time, size);
		if (hit) {
			if (cursor?.work) cursor.time = time;
			this.pinned.add(hit);
			this.entries.delete(hit);
			this.entries.add(hit);
			return hit.frame;
		}
		const behind = !!cursor && time < (cursor.start ?? cursor.time);
		if (cursor?.work && (behind || time >= cursor.end)) {
			// Finish the same clip's in-flight read before seeking to the coalesced target.
			await cursor.work;
			options.signal?.throwIfAborted();
			if (this.cursor !== cursor) return null;
			return this.getFrameAt(file, clip, time, options);
		}
		if (!cursor || behind || (!cursor.work && time >= cursor.end)) {
			if (cursor) this.retire(cursor);
			cursor = this.cursor = { source, clip, time, end: Infinity };
		}
		if (time > cursor.time) cursor.windowStart = undefined;
		cursor.time = time;
		cursor.requested = true;
		if (!cursor.work) {
			const active = cursor;
			active.work = this.decode(active, track, size).finally(() => { active.work = undefined; });
		}
		await cursor.work;
		options.signal?.throwIfAborted();
		if (this.cursor !== cursor || cursor.time !== time) return null;
		const frame = this.find(source, time, size);
		if (frame) {
			this.pinned.add(frame);
			return frame.frame;
		}
		// An oversized surface may exceed the ring's budget by itself.
		const current = cursor.current;
		if (!current || time < (cursor.start ?? Infinity) ||
			!(time === current.timestamp || cursor.exhausted || (cursor.next && time < cursor.next.timestamp))) return null;
		if (cursor.windowStart === undefined && previous?.previous !== undefined &&
			time < previous.time && previous.time < previous.previous) {
			const active = cursor;
			const prior = previous.previous;
			const duration = current.duration;
			this.fill = () => {
				void active.bounds?.then(({ start, end }) => {
					if (this.cursor !== active || active.time !== time || active.work || prior >= end ||
						time < start || this.target?.time !== time || this.target.clip !== clip) return;
					const windowStart = Math.max(start, time - (duration > 0 ? 80 * duration : 3));
					this.retire(active);
					const filling: Cursor = this.cursor = { source, clip, time, windowStart, end };
					filling.work = this.decode(filling, track, size).catch(() => {}).finally(() => { filling.work = undefined; });
				});
			};
		}
		return this.rasterize(current, track, size);
	}

	private async decode(cursor: Cursor, track: InputVideoTrack, size: { width: number; height: number }): Promise<void> {
		if (!cursor.samples) {
			while (this.retiring.size >= 2) await Promise.race(this.retiring);
			if (this.cursor !== cursor) return;
			cursor.start = cursor.windowStart ?? cursor.time;
			cursor.samples = new VideoSampleSink(track).samples(cursor.start);
			const at = cursor.time;
			cursor.bounds = (async () => {
				const packets = new EncodedPacketSink(track);
				const key = await packets.getKeyPacket(at, { verifyKeyPackets: true });
				const next = key && await packets.getNextKeyPacket(key, { metadataOnly: true });
				cursor.end = next?.timestamp ?? Infinity;
				return { start: key?.timestamp ?? at, end: cursor.end };
			})().catch(() => ({ start: at, end: Infinity }));
		}
		let copied = 0;
		while (this.cursor === cursor) {
			if (!cursor.current) {
				const first = await cursor.samples.next();
				if (this.cursor !== cursor || !first.value) { first.value?.close(); return; }
				cursor.current = first.value;
				cursor.start = Math.min(cursor.time, first.value.timestamp);
			}
			if (cursor.current.timestamp === cursor.time && cursor.requested) return;
			if (!cursor.next) {
				const next = await cursor.samples.next();
				if (this.cursor !== cursor) { next.value?.close(); return; }
				cursor.next = next.value ?? undefined;
				cursor.exhausted = next.done === true;
			}
			const current = cursor.current;
			const end = cursor.next?.timestamp ?? Infinity;
			if (end === current.timestamp) {
				// Duplicate timestamps require the normal sink's selection semantics.
				this.stop();
				return;
			}
			const reached = cursor.time < end;
			if (reached && cursor.requested) return;
			// The next presentation timestamp covers gaps between VFR samples.
			if (cursor.windowStart !== undefined && cursor.start !== undefined && end > cursor.start) {
				this.remember(cursor.source, cursor.start, end, current, track, size);
				if (!reached && ++copied % 8 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
			if (this.cursor !== cursor || cursor.time < end) return;
			if (reached || !cursor.next) return;
			current.close();
			cursor.current = cursor.next;
			cursor.start = cursor.next.timestamp;
			cursor.next = undefined;
		}
	}

	private find(source: Source, time: number, size: { width: number; height: number }): Entry | undefined {
		for (const entry of this.entries) {
			if (entry.source === source && time >= entry.start && (time < entry.end || time === entry.start) &&
				entry.frame.canvas.width === size.width && entry.frame.canvas.height === size.height) return entry;
		}
	}

	private rasterize(sample: VideoSample, track: InputVideoTrack, { width, height }: { width: number; height: number }, canvas = new OffscreenCanvas(width, height)): VideoFrame {
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Failed to get 2d context for video frame");
		ctx.clearRect(0, 0, width, height);
		sample.drawWithFit(ctx, { fit: "fill", rotation: track.rotation });
		return { canvas, timestamp: sample.timestamp, sourceWidth: track.displayWidth, sourceHeight: track.displayHeight };
	}

	private remember(source: Source, start: number, end: number, sample: VideoSample, track: InputVideoTrack, size: { width: number; height: number }): void {
		const bytes = size.width * size.height * 4;
		if (bytes > FRAME_BYTES) return;
		const known = this.find(source, start, size);
		if (known) {
			known.end = Math.max(known.end, end);
			return;
		}
		let canvas: OffscreenCanvas | undefined;
		while (this.entries.size >= FRAME_LIMIT || this.bytes + bytes > FRAME_BYTES) {
			const oldest = [...this.entries].find((entry) => !this.pinned.has(entry));
			if (!oldest) return;
			if (!canvas && oldest.frame.canvas.width === size.width && oldest.frame.canvas.height === size.height) {
				canvas = oldest.frame.canvas;
				this.entries.delete(oldest);
				this.bytes -= oldest.bytes;
			} else this.drop(oldest);
		}
		this.entries.add({ source, start, end, bytes, frame: this.rasterize(sample, track, size, canvas) });
		this.bytes += bytes;
	}

	private drop(entry: Entry): void {
		this.entries.delete(entry);
		this.bytes -= entry.bytes;
		entry.frame.canvas.width = entry.frame.canvas.height = 0;
	}

	private open(file: File): Source {
		const existing = this.sources.get(file);
		if (existing) {
			this.sources.delete(file);
			this.sources.set(file, existing);
			return existing;
		}
		const bytes = Math.min(file.size, READ_BYTES) + 512 * 1024;
		while (this.sources.size >= SOURCE_LIMIT || this.sourceBytes + bytes > SOURCE_BYTES) {
			const oldest = [...this.sources].find(([, source]) => ![...this.pinned].some((entry) => entry.source === source));
			if (!oldest) break;
			this.discard(...oldest);
		}
		if (this.sources.size >= SOURCE_LIMIT || this.sourceBytes + bytes > SOURCE_BYTES) throw new Error("Scrub source cache is full");
		const input = new Input({ source: new BlobSource(file, { maxCacheSize: READ_BYTES }), formats: ALL_FORMATS });
		const source = { input, bytes, track: getDecodableVideoTrack(input) };
		this.sources.set(file, source);
		this.sourceBytes += bytes;
		return source;
	}

	private discard(file: File, source: Source): void {
		if (this.cursor?.source === source) this.stop();
		source.input.dispose();
		this.sources.delete(file);
		this.sourceBytes -= source.bytes;
		for (const entry of this.entries) if (entry.source === source) this.drop(entry);
	}

	finishFrame(presented = false): void {
		this.pinned.clear();
		const fill = this.fill;
		this.fill = undefined;
		if (presented) fill?.();
	}

	stop(): void {
		this.target = undefined;
		this.fill = undefined;
		if (this.cursor) this.retire(this.cursor);
	}

	private retire(cursor: Cursor): void {
		this.cursor = undefined;
		if (!cursor.samples) return;
		const retirement = Promise.allSettled([cursor.work]).then(async () => {
			cursor.current?.close();
			cursor.next?.close();
			await cursor.samples?.return().catch(() => {});
		}).finally(() => {
			this.retiring.delete(retirement);
		});
		this.retiring.add(retirement);
	}

	clear(): void {
		this.stop();
		this.finishFrame();
		for (const [file, source] of this.sources) this.discard(file, source);
	}
}
