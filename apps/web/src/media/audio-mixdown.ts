import type { Input } from "mediabunny";
import { collectAudibleCandidates, resolvePitchSourceEnd } from "@/media/audio";
import { createStereoSampler, resamplePadding } from "@/media/audio-resample";
import { createBlockMastering } from "@/media/audio-mastering";
import { createAudioCheckpoint, decodeAudioWindow, openAudioInput, sliceAudioWindow, STEREO_CHANNELS, yieldAudioTask, type DecodedAudioWindow } from "@/media/audio-window";
import { mediaSupportsAudio } from "@/media/media-utils";
import type { MediaAsset, MediaLoadFailure } from "@/media/types";
import { createPitchReader, shouldMaintainPitch, clampRetimeRate, MAX_RETIME_RATE } from "@/retime";
import type { AudioCapableElement } from "@/timeline/audio-state";
import { hasAnimatedVolume, isElementMuted, resolveEffectiveAudioGain } from "@/timeline/audio-state";
import type { SceneTracks, TScene } from "@/timeline";
import { waitWithAbort } from "@/utils/abort";
import { TICKS_PER_SECOND } from "@/wasm";

export const EXPORT_SAMPLE_RATE = 44_100;
const BLOCK_SECONDS = 5;
const MAX_WINDOW_SECONDS = BLOCK_SECONDS * MAX_RETIME_RATE;
const MAX_OPEN_INPUTS = 4;
const MAX_CACHED_BYTES = 32 * 2 ** 20;
const MAX_CACHED_WINDOWS = 128;

interface MixClip {
	element: AudioCapableElement;
	start: number;
	end: number;
	duration: number;
	trim: number;
	rate: number;
	preservePitch: boolean;
	gain: number;
	animated: boolean;
}

interface MixSource {
	failure: Omit<MediaLoadFailure, "error">;
	file?: Blob;
	buffer?: AudioBuffer;
	sourceUrl?: string;
	requiresAudio: boolean;
}

interface WindowRequest {
	start: number;
	end: number;
	clips: MixClip[];
}

function addClipWindow(requests: WindowRequest[], clip: MixClip, start: number, end: number, sampleRate: number): void {
	const clipStart = clip.trim;
	const clipEnd = clipStart + clip.duration * clip.rate;
	const useWholeClip = clipEnd - clipStart <= MAX_WINDOW_SECONDS;
	const padding = resamplePadding(sampleRate, clip.rate);
	requests.push({
		start: (useWholeClip ? clipStart : clipStart + Math.max(0, start) * clip.rate) - padding,
		end: (useWholeClip ? clipEnd : clipStart + end * clip.rate) + padding,
		clips: [clip],
	});
}

function mergeWindows(requests: WindowRequest[], sampleRate: number): WindowRequest[] {
	const maxWindow = MAX_WINDOW_SECONDS + 2 * resamplePadding(sampleRate, MAX_RETIME_RATE);
	requests.sort((a, b) => a.start - b.start);
	const windows: WindowRequest[] = [];
	for (const request of requests) {
		const previous = windows.at(-1);
		if (previous && request.start <= previous.end &&
			request.end - previous.start <= maxWindow) {
			previous.end = Math.max(previous.end, request.end);
			previous.clips.push(...request.clips);
		} else {
			windows.push(request);
		}
	}
	return windows;
}

function bufferSize(buffer: AudioBuffer): number {
	return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

class AudioBufferCache<K, V extends DecodedAudioWindow> {
	private entries = new Map<K, V>();
	private bytes = 0;

	constructor(private budget: number) {}

	find(matches: (key: K, value: V) => boolean): V | undefined {
		for (const [key, value] of this.entries) {
			if (!matches(key, value)) continue;
			this.entries.delete(key);
			this.entries.set(key, value);
			return value;
		}
	}

	add(key: K, value: V): void {
		const bytes = bufferSize(value.buffer);
		if (bytes > this.budget) return;
		for (const [oldKey, oldValue] of this.entries) {
			if (this.bytes + bytes <= this.budget && this.entries.size < MAX_CACHED_WINDOWS) break;
			this.entries.delete(oldKey);
			this.bytes -= bufferSize(oldValue.buffer);
		}
		this.entries.set(key, value);
		this.bytes += bytes;
	}
}

export async function* mixTimelineAudio({
	tracks, mediaAssets, duration, scenes, rangeStart = 0, sampleRate = EXPORT_SAMPLE_RATE, onFailure, signal,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	/** First timeline tick to emit. Duration remains the exclusive end tick. */
	rangeStart?: number;
	scenes?: TScene[];
	sampleRate?: number;
	onFailure?: (failure: MediaLoadFailure) => void;
	signal?: AbortSignal;
}): AsyncGenerator<AudioBuffer, void, unknown> {
	const sources = new Map<string, MixSource>();
	const clips: Array<MixClip & { source: MixSource }> = [];
	for (const { element, mediaAsset } of collectAudibleCandidates({ tracks, mediaAssets, scenes, rangeStart, duration })) {
		if (isElementMuted({ element })) continue;
		const library = element.type === "audio" && element.sourceType === "library" ? element : null;
		const asset = mediaAsset?.file && mediaSupportsAudio({ media: mediaAsset }) ? mediaAsset : null;
		if (!library && !asset) continue;
		const id = library ? `library:${library.sourceUrl}` : asset?.id;
		if (!id) continue;
		let source = sources.get(id);
		if (!source) {
			source = {
				file: library ? undefined : asset?.file,
				sourceUrl: library?.sourceUrl,
				buffer: library?.buffer,
				requiresAudio: false,
				failure: library ? { id, name: library.name, sourceUrl: library.sourceUrl }
					: { id, name: asset?.name ?? element.name, unreadable: true },
			};
			sources.set(id, source);
		}
		source.buffer ??= library?.buffer;
		source.requiresAudio ||= element.type === "audio" || mediaAsset?.hasAudio === true;
		const rate = clampRetimeRate({ rate: element.retime?.rate ?? 1 });
		const start = Math.floor(element.startTime / TICKS_PER_SECOND * sampleRate);
		const seconds = element.duration / TICKS_PER_SECOND;
		clips.push({
			source, element, rate, start, end: start + Math.ceil(seconds * sampleRate),
			duration: seconds, trim: element.trimStart / TICKS_PER_SECOND,
			preservePitch: rate !== 1 && shouldMaintainPitch({ rate, maintainPitch: element.retime?.maintainPitch }),
			gain: resolveEffectiveAudioGain({ element, localTime: 0 }),
			animated: hasAnimatedVolume({ element }),
		});
	}
	if (!clips.length) return;
	clips.sort((a, b) => a.start - b.start);

	const inputs = new Map<MixSource, Input>();
	const unavailable = new Set<MixSource>();
	const decoded = new AudioBufferCache<WindowRequest, DecodedAudioWindow & { source: MixSource }>(MAX_CACHED_BYTES);
	const pitchReaders = new Map<MixClip, ReturnType<typeof createPitchReader>>();

	const getInput = async (source: MixSource) => {
		const existing = inputs.get(source);
		if (existing) {
			inputs.delete(source);
			inputs.set(source, existing);
			return existing;
		}

		let file = source.file;
		if (!file) {
			if (!source.sourceUrl) throw new Error("No audio source available");
			const response = await waitWithAbort(fetch(source.sourceUrl, { signal }), signal);
			if (!response.ok) throw new Error(`Library audio fetch failed: ${response.status}`);
			file = await waitWithAbort(response.blob(), signal);
		}
		if (inputs.size >= MAX_OPEN_INPUTS) {
			const oldest = inputs.keys().next().value!;
			inputs.get(oldest)!.dispose();
			inputs.delete(oldest);
		}
		const input = openAudioInput(file);
		inputs.set(source, input);
		return input;
	};

	const report = (failure: Omit<MediaLoadFailure, "error">, error: unknown) => {
		signal?.throwIfAborted();
		const message = error instanceof Error ? error.message : String(error);
		if (!onFailure) throw new Error(`Could not decode audio for "${failure.name}": ${message}`, { cause: error });
		onFailure({ ...failure, error: message });
	};

	const decode = async (source: MixSource, request: WindowRequest) => {
		const pause = checkpoint();
		if (pause) await pause;
		if (unavailable.has(source)) return null;
		const cached = decoded.find((key, value) =>
			value.source === source && key.start <= request.start && key.end >= request.end,
		);
		if (cached) return cached;

		try {
			const window = source.buffer ? sliceAudioWindow(source.buffer, request.start, request.end)
				: await decodeAudioWindow({
					input: await getInput(source), start: request.start, end: request.end,
					requiresAudio: source.requiresAudio, signal,
				});
			if (window) decoded.add(request, { ...window, source });
			else unavailable.add(source);
			return window;
		} catch (error) {
			unavailable.add(source);
			inputs.get(source)?.dispose();
			inputs.delete(source);
			report(source.failure, error);
			return null;
		}
	};

	const length = Math.ceil(duration / TICKS_PER_SECOND * sampleRate);
	const master = createBlockMastering(sampleRate);
	const checkpoint = createAudioCheckpoint(signal);
	let nextClip = 0;
	let active: typeof clips = [];
	let silentBlock: AudioBuffer | undefined;
	try {
		for (let start = Math.floor(rangeStart / TICKS_PER_SECOND * sampleRate); start < length; start += BLOCK_SECONDS * sampleRate) {
			signal?.throwIfAborted();
			const end = Math.min(length, start + BLOCK_SECONDS * sampleRate);
			active = active.filter((clip) => {
				if (clip.end > start) return true;
				pitchReaders.delete(clip);
				return false;
			});
			while (nextClip < clips.length && clips[nextClip].start < end) {
				const clip = clips[nextClip++];
				if (clip.end > start) active.push(clip);
			}

			if (!active.length) {
				master.advanceSilence(end - start);
				if (silentBlock?.length !== end - start) {
					silentBlock = new AudioBuffer({ numberOfChannels: STEREO_CHANNELS, length: end - start, sampleRate });
				}
				await yieldAudioTask(signal);
				yield silentBlock;
				continue;
			}
			const output = new AudioBuffer({ numberOfChannels: STEREO_CHANNELS, length: end - start, sampleRate });
			const requests = new Map<MixSource, WindowRequest[]>();
			for (const clip of active) {
				if (unavailable.has(clip.source)) continue;
				if (clip.preservePitch) continue;
				let windows = requests.get(clip.source);
				if (!windows) requests.set(clip.source, windows = []);
				// Block boundaries are in output samples; the decode window remains in source seconds.
				addClipWindow(windows, clip, (start - clip.start) / sampleRate,
					(Math.min(end, clip.end) - clip.start) / sampleRate, sampleRate);
			}

			// One decoder runs at a time. Each decoded window is mixed before opening the next.
			for (const [source, windows] of requests) {
				for (const request of mergeWindows(windows, sampleRate)) {
					const window = await decode(source, request);
					if (!window) break;
					for (const clip of request.clips) {
						await mixClip({ clip, window, output, start, end, checkpoint, stretched: false });
					}
				}
			}

			for (const clip of active) {
				if (!clip.preservePitch || unavailable.has(clip.source)) continue;
				const from = Math.max(clip.start, start);
				let read = pitchReaders.get(clip);
				if (!read) {
					read = createPitchReader({
						readWindow: (sourceStart, sourceEnd) => decode(clip.source, {
							start: sourceStart, end: sourceEnd, clips: [],
						}),
						sourceStart: clip.trim,
						...resolvePitchSourceEnd(clip.element, clip.rate),
						readStart: clip.trim + (from - clip.start) / sampleRate * clip.rate,
						rate: clip.rate, sampleRate, signal,
					});
					pitchReaders.set(clip, read);
				}
				const buffer = await read(Math.min(clip.end, end) - from);
				const window = { buffer, start: 0 };
				await mixClip({ clip, window, output, start, end, checkpoint, stretched: true });
			}

			await master.process(output, signal);
			await yieldAudioTask(signal);
			yield output;
		}
	} finally {
		for (const input of inputs.values()) input.dispose();
	}
}

async function mixClip({
	clip, window, output, start, end, checkpoint, stretched,
}: {
	clip: MixClip;
	window: DecodedAudioWindow;
	output: AudioBuffer;
	start: number;
	end: number;
	checkpoint: ReturnType<typeof createAudioCheckpoint>;
	stretched: boolean;
}): Promise<void> {
	const { buffer } = window;
	const outputLeft = output.getChannelData(0);
	const outputRight = output.getChannelData(1);
	const from = Math.max(start, clip.start);
	const to = Math.min(end, clip.end);
	const rate = stretched ? 1 : clip.rate;
	const { sampleRate: nativeRate } = buffer;
	const { sourceEnd } = resolvePitchSourceEnd(clip.element, clip.rate);
	const sample = createStereoSampler(buffer, rate * nativeRate / output.sampleRate, stretched ? undefined : {
		end: Math.ceil(sourceEnd * nativeRate - 1e-7) - Math.round(window.start * nativeRate),
	});
	const stereo = new Float64Array(2);
	const trim = (stretched ? 0 : clip.trim) - window.start;
	for (let block = from; block < to; block += 4096) {
		const pause = checkpoint();
		if (pause) await pause;
		for (let index = block; index < Math.min(block + 4096, to); index++) {
			const time = (index - clip.start) / output.sampleRate;
			const position = stretched ? index - from : (trim + time * rate) * buffer.sampleRate;
			sample(position, stereo);
			const gain = clip.animated ? resolveEffectiveAudioGain({ element: clip.element, localTime: time }) : clip.gain;
			const offset = index - start;
			outputLeft[offset] += stereo[0] * gain;
			outputRight[offset] += stereo[1] * gain;
		}
	}
}
