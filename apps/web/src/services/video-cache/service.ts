import {
	ALL_FORMATS,
	BlobSource,
	EncodedPacketSink,
	Input,
	UrlSource,
	VideoSampleSink,
	type InputVideoTrack,
	type VideoSample,
} from "mediabunny";
import { getDecodableVideoTrack } from "@/media/video-probe";
import { fitSurfaceSize } from "@/services/renderer/scale";
import { waitWithAbort } from "@/utils/abort";

type VideoSize = { width: number; height: number };
type VideoFrame = {
	canvas: OffscreenCanvas;
	timestamp: number;
	sourceWidth: number;
	sourceHeight: number;
};
type VideoRequest = { cursor: VideoCursor; sample: Promise<VideoSample | null> };
type VideoSeek = { file: File | string; time: number; throwOnSeekError?: boolean; signal?: AbortSignal };
type VideoSource = {
	input: Input;
	track: Promise<InputVideoTrack>;
	cursors: VideoCursor[];
	requests: Map<number, VideoRequest>;
	used: Set<VideoCursor>;
	lastPacketTime?: Promise<number | undefined>;
};

class VideoCursor {
	private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
	private currentStart = 0;
	private current: VideoSample | null = null;
	private next: Promise<VideoSample | null> | null = null;
	exhausted = false;
	private sink: VideoSampleSink;
	private surfaces: { canvas: OffscreenCanvas; timestamp: number }[] = [];
	private frames = new Map<string, VideoFrame>();

	constructor(track: InputVideoTrack) {
		this.sink = new VideoSampleSink(track);
	}

	distanceFrom(time: number): number {
		return Math.abs(time - this.currentStart);
	}

	async readAt(time: number): Promise<VideoSample | null> {
		const start = this.currentStart;
		const iterator = this.iterator;
		if (iterator && time >= start) {
			if (this.current && time < this.current.timestamp) return this.current;
			try {
				if (time < start + 2) return await this.advanceTo(time);
				const next = await this.next;
				if (iterator !== this.iterator) return null;
				// A known gap or end of stream is cheaper to hold than to seek again.
				if (!next || next.timestamp > time) return this.current;
			} catch {
				if (iterator !== this.iterator) return null;
				// Retry a failed sequential read from its keyframe.
			}
		}

		this.reset();
		this.currentStart = time;
		this.iterator = this.sink.samples(time);
		this.prefetch(this.iterator);
		return this.advanceTo(time);
	}

	private async advanceTo(time: number): Promise<VideoSample | null> {
		const iterator = this.iterator;
		while (iterator && this.next && this.current?.timestamp !== time) {
			const next = await this.next;
			if (iterator !== this.iterator) return null;
			if (!next) {
				if (!this.current) throw new Error("No video frames could be decoded");
				break;
			}
			if (this.current && next.timestamp > time) break;

			this.current?.close();
			this.current = next;
			// A seek before the first presentation timestamp displays the first sample immediately.
			this.currentStart = Math.min(next.timestamp, time);
			this.prefetch(iterator);
			if (next.timestamp >= time) break;
		}
		// A frame remains active until the next presentation timestamp, including VFR gaps.
		return this.current;
	}

	private prefetch(iterator: AsyncGenerator<VideoSample, void, unknown>): void {
		this.next = iterator.next().then(({ value }) => {
			if (iterator === this.iterator) {
				this.exhausted = value === undefined;
				return value ?? null;
			}
			value?.close();
			return null;
		});
		// The next request can recover by seeking, even if prefetch fails between renders.
		void this.next.catch(() => {});
	}

	rasterize(sample: VideoSample, track: InputVideoTrack, scale: number, maxTextureDimension: number): VideoFrame {
		const sourceWidth = track.displayWidth;
		const sourceHeight = track.displayHeight;
		// Round up in half-octave steps so a zoom animation can reuse the same canvas allocation.
		const budget = scale >= 1 || !Number.isFinite(scale)
			? 1
			: 2 ** (Math.ceil(Math.log2(Math.max(0, scale)) * 2) / 2);
		const { width, height } = budget * Math.max(sourceWidth, sourceHeight) > maxTextureDimension
			? fitSurfaceSize(sourceWidth, sourceHeight, maxTextureDimension)
			: {
				width: Math.max(1, Math.ceil(sourceWidth * budget)),
				height: Math.max(1, Math.ceil(sourceHeight * budget)),
			};
		const key = `${width}x${height}`;
		const cached = this.frames.get(key);
		if (cached) return cached;

		const index = this.frames.size;
		const surface = this.surfaces[index] ?? {
			canvas: new OffscreenCanvas(width, height),
			timestamp: NaN,
		};
		const { canvas } = surface;
		const resized = canvas.width !== width || canvas.height !== height;
		if (resized) {
			canvas.width = width;
			canvas.height = height;
		}
		if (resized || surface.timestamp !== sample.timestamp) {
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Failed to get 2d context for video frame");
			ctx.clearRect(0, 0, width, height);
			sample.drawWithFit(ctx, { fit: "fill", rotation: track.rotation });
			surface.timestamp = sample.timestamp;
		}
		this.surfaces[index] = surface;
		const frame = { canvas, timestamp: sample.timestamp, sourceWidth, sourceHeight };
		this.frames.set(key, frame);
		return frame;
	}

	finishFrame(): void {
		this.surfaces.length = this.frames.size;
		this.frames.clear();
	}

	private reset(): void {
		const { iterator, next } = this;
		this.iterator = null;
		this.next = null;
		this.exhausted = false;
		this.current?.close();
		this.current = null;
		// A resolved lookahead belongs to this cursor even if we never advance to it.
		void next?.then((sample) => sample?.close(), () => {});
		void iterator?.return().catch(() => {});
	}

	dispose(): void {
		this.reset();
		this.frames.clear();
		this.surfaces.length = 0;
	}
}

/** Video samples and surfaces belong to one renderer. A cursor serves one source time per frame. */
export class VideoCache {
	private sources = new Map<File | string, VideoSource>();
	private failedSources = new WeakMap<File, { error: unknown }>();

	async getFrameAt({
		getScale,
		maxTextureDimension = Infinity,
		...seek
	}: VideoSeek & {
		getScale?: (source: VideoSize) => number;
		maxTextureDimension?: number;
	}): Promise<VideoFrame | null> {
		const decoded = await this.readAt(seek);
		seek.signal?.throwIfAborted();
		if (!decoded) return null;
		const { sample, track, cursor } = decoded;
		const scale = getScale?.({ width: track.displayWidth, height: track.displayHeight }) ?? 1;
		return cursor.rasterize(sample, track, scale, maxTextureDimension);
	}

	async prepareFrame(seek: VideoSeek): Promise<boolean> {
		return (await this.readAt(seek)) !== null;
	}

	async getProxyFrameAt(file: string, time: number, maxTextureDimension: number, signal?: AbortSignal) {
		const deadline = AbortSignal.timeout(1000);
		const scope = signal ? AbortSignal.any([signal, deadline]) : deadline;
		try {
			const frame = await waitWithAbort(this.getFrameAt({ file, time, maxTextureDimension, signal: scope }), scope);
			if (frame) return frame;
		} catch {
			signal?.throwIfAborted();
		} finally {
			if (scope.aborted) this.discardSource(file);
		}
		this.discardSource(file);
		return null;
	}

	takePreparedSources(cache: VideoCache): void {
		for (const [file, source] of cache.sources) {
			const previous = this.sources.get(file);
			if (previous) {
				for (const cursor of previous.cursors) cursor.dispose();
				previous.input.dispose();
			}
			this.sources.set(file, source);
		}
		cache.sources.clear();
	}

	private async readAt({ file, time, throwOnSeekError = false, signal }: VideoSeek) {
		signal?.throwIfAborted();
		const failed = typeof file === "string" ? undefined : this.failedSources.get(file);
		if (failed) {
			if (throwOnSeekError) throw failed.error;
			return null;
		}
		const source = this.getSource(file);
		let track: InputVideoTrack;
		try {
			track = await source.track;
		} catch (error) {
			signal?.throwIfAborted();
			if (throwOnSeekError) throw error;
			return null;
		}
		signal?.throwIfAborted();
		if (this.sources.get(file) !== source) return null;

		let request = source.requests.get(time);
		if (!request) {
			let cursor: VideoCursor | undefined;
			for (const candidate of source.cursors) {
				if (source.used.has(candidate)) continue;
				if (!cursor || candidate.distanceFrom(time) < cursor.distanceFrom(time)) {
					cursor = candidate;
				}
			}
			if (!cursor) {
				cursor = new VideoCursor(track);
				source.cursors.push(cursor);
			}
			request = { cursor, sample: cursor.readAt(time) };
			source.requests.set(time, request);
			source.used.add(cursor);
		}

		let sample: VideoSample | null;
		try {
			sample = await request.sample;
		} catch (error) {
			signal?.throwIfAborted();
			if (throwOnSeekError) throw error;
			console.warn("Failed to seek video:", error);
			return null;
		}
		signal?.throwIfAborted();
		if (this.sources.get(file) !== source || !sample) return null;
		if (throwOnSeekError && request.cursor.exhausted && time > sample.timestamp &&
			time >= sample.timestamp + sample.duration) {
			// Real VFR gaps and holds past a video's last frame are valid. An early end
			// while the container still advertises later packets is a failed decode.
			source.lastPacketTime ??= new EncodedPacketSink(track).getPacket(Infinity, { metadataOnly: true })
				.then((packet) => packet?.timestamp);
			const lastPacketTime = await source.lastPacketTime;
			signal?.throwIfAborted();
			if (this.sources.get(file) !== source) return null;
			if (lastPacketTime !== undefined && lastPacketTime - sample.timestamp > 1e-6) {
				throw new Error("Video decoding ended before the last packet");
			}
		}
		return { sample, track, cursor: request.cursor };
	}

	private getSource(file: File | string): VideoSource {
		const existing = this.sources.get(file);
		if (existing) return existing;

		const input = new Input({
			source: typeof file === "string" ? new UrlSource(file, { getRetryDelay: () => null }) : new BlobSource(file),
			formats: ALL_FORMATS,
		});
		const track = getDecodableVideoTrack(input).catch((error) => {
			if (this.sources.get(file)?.input === input) {
				this.sources.delete(file);
				if (typeof file !== "string") this.failedSources.set(file, { error });
				input.dispose();
				console.warn(`Failed to open video "${typeof file === "string" ? file : file.name}":`, error);
			}
			throw error;
		});
		const source: VideoSource = { input, track, cursors: [], requests: new Map(), used: new Set() };
		this.sources.set(file, source);
		return source;
	}

	discardSource(file: File | string) {
		const source = this.sources.get(file);
		if (!source) return;
		this.sources.delete(file);
		for (const cursor of source.cursors) cursor.dispose();
		source.input.dispose();
	}

	finishFrame(): void {
		for (const [file, source] of this.sources) {
			for (const cursor of source.cursors) {
				if (source.used.has(cursor)) cursor.finishFrame();
				else cursor.dispose();
			}
			source.cursors = source.cursors.filter((cursor) => source.used.has(cursor));
			source.requests.clear();
			source.used.clear();
			if (!source.cursors.length) {
				source.input.dispose();
				this.sources.delete(file);
			}
		}
	}

	clear(): void {
		for (const source of this.sources.values()) {
			for (const cursor of source.cursors) cursor.dispose();
			source.input.dispose();
		}
		this.sources.clear();
		this.failedSources = new WeakMap();
	}
}
