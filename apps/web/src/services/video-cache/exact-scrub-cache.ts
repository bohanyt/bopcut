import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from "mediabunny";
import { getDecodableVideoTrack } from "@/media/video-probe";
import { videoSurfaceSize, type VideoFrame } from "./service";

const SOURCE_LIMIT = 6;
const SOURCE_BYTES = 32 * 1024 * 1024;
const READ_BYTES = 8 * 1024 * 1024;
const FRAME_LIMIT = 180;
const FRAME_BYTES = 128 * 1024 * 1024;

type Source = { input: Input; track: Promise<InputVideoTrack>; bytes: number; lastTime?: number };
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
	backfill: boolean;
	end: number;
	start?: number;
	current?: VideoSample;
	next?: VideoSample;
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
	private retired = Promise.resolve();

	async getFrameAt(file: File, clip: object, time: number, options: Options): Promise<VideoFrame | null> {
		options.signal?.throwIfAborted();
		const source = this.open(file);
		const backward = source.lastTime !== undefined && time < source.lastTime;
		source.lastTime = time;
		const track = await source.track;
		options.signal?.throwIfAborted();
		if (this.sources.get(file) !== source) return null;
		const size = videoSurfaceSize(track.displayWidth, track.displayHeight, options.getScale({
			width: track.displayWidth, height: track.displayHeight,
		}), options.maxTextureDimension);
		let cursor = this.cursor;
		if (cursor && (cursor.source !== source || (cursor.clip !== clip && cursor.time !== time) ||
			time < (cursor.start ?? (cursor.backfill ? -Infinity : cursor.time)))) {
			this.stop();
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
		if (!cursor || (!cursor.work && time >= cursor.end)) {
			this.stop();
			cursor = this.cursor = { source, clip, time, backfill: backward, end: Infinity };
		}
		cursor.time = time;
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
		return cursor.current && time >= (cursor.start ?? Infinity) && time < (cursor.next?.timestamp ?? Infinity)
			? this.rasterize(cursor.current, track, size)
			: null;
	}

	private async decode(cursor: Cursor, track: InputVideoTrack, size: { width: number; height: number }): Promise<void> {
		await this.retired;
		if (this.cursor !== cursor) return;
		if (!cursor.samples) {
			const packets = new EncodedPacketSink(track);
			const key = await packets.getKeyPacket(cursor.time, { verifyKeyPackets: true });
			const next = key && await packets.getNextKeyPacket(key, { metadataOnly: true });
			if (this.cursor !== cursor) return;
			cursor.end = next?.timestamp ?? Infinity;
			cursor.start = cursor.backfill && key && key.timestamp <= cursor.time ? key.timestamp : cursor.time;
			cursor.samples = new VideoSampleSink(track).samples(cursor.start);
		}
		while (this.cursor === cursor) {
			if (!cursor.current) {
				const first = await cursor.samples.next();
				if (this.cursor !== cursor || !first.value) { first.value?.close(); return; }
				cursor.current = first.value;
				cursor.start = Math.min(cursor.time, first.value.timestamp);
			}
			if (!cursor.next) {
				const next = await cursor.samples.next();
				if (this.cursor !== cursor) { next.value?.close(); return; }
				cursor.next = next.value ?? undefined;
			}
			const current = cursor.current;
			const end = cursor.next?.timestamp ?? Infinity;
			if (end === current.timestamp) {
				// Duplicate timestamps require the normal sink's selection semantics.
				this.stop();
				return;
			}
			const reached = cursor.time < end;
			// The next presentation timestamp covers gaps between VFR samples.
			if ((reached || cursor.backfill) && cursor.start !== undefined && end > cursor.start) {
				this.remember(cursor.source, cursor.start, end, current, track, size);
			}
			if (reached || !cursor.next) return;
			current.close();
			cursor.current = cursor.next;
			cursor.start = cursor.next.timestamp;
			cursor.next = undefined;
		}
	}

	private find(source: Source, time: number, size: { width: number; height: number }): Entry | undefined {
		for (const entry of this.entries) {
			if (entry.source === source && time >= entry.start && time < entry.end &&
				entry.frame.canvas.width === size.width && entry.frame.canvas.height === size.height) return entry;
		}
	}

	private rasterize(sample: VideoSample, track: InputVideoTrack, { width, height }: { width: number; height: number }): VideoFrame {
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Failed to get 2d context for video frame");
		sample.drawWithFit(ctx, { fit: "fill", rotation: track.rotation });
		return { canvas, timestamp: sample.timestamp, sourceWidth: track.displayWidth, sourceHeight: track.displayHeight };
	}

	private remember(source: Source, start: number, end: number, sample: VideoSample, track: InputVideoTrack, size: { width: number; height: number }): void {
		const bytes = size.width * size.height * 4;
		if (bytes > FRAME_BYTES || this.find(source, start, size)) return;
		while (this.entries.size >= FRAME_LIMIT || this.bytes + bytes > FRAME_BYTES) {
			const oldest = [...this.entries].find((entry) => !this.pinned.has(entry));
			if (!oldest) return;
			this.drop(oldest);
		}
		this.entries.add({ source, start, end, bytes, frame: this.rasterize(sample, track, size) });
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

	finishFrame(): void { this.pinned.clear(); }

	stop(): void {
		const cursor = this.cursor;
		if (!cursor) return;
		this.cursor = undefined;
		this.retired = Promise.allSettled([this.retired, cursor.work]).then(async () => {
			cursor.current?.close();
			cursor.next?.close();
			await cursor.samples?.return().catch(() => {});
		});
	}

	clear(): void {
		this.stop();
		this.finishFrame();
		for (const [file, source] of this.sources) this.discard(file, source);
	}
}
