import type {
	AudioElement,
	VideoElement,
	LibraryAudioElement,
	RetimeConfig,
	SceneTracks,
	TScene,
} from "@/timeline";
import { expandCompoundAudioTracks } from "@/timeline/compound";
import { shouldMaintainPitch } from "@/retime/rate";
import type { MediaAsset, MediaLoadFailure } from "@/media/types";
import { applyAudioMasteringToBuffer } from "@/media/audio-mastering";
import type { AudioCapableElement } from "@/timeline/audio-state";
import {
	hasAnimatedVolume,
	isElementMuted,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { doesElementHaveEnabledAudio, isSourceAudioEnabled } from "@/timeline/audio-separation";
import { canElementHaveAudio, hasMediaId } from "@/timeline/element-utils";
import { canTrackHaveAudio } from "@/timeline";
import { mediaSupportsAudio } from "@/media/media-utils";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/retime";
import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from "mediabunny";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	computeRmsBuckets,
	type SampleBucket,
} from "@/media/waveform-summary";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;

export interface CollectedAudioElement {
	timelineElement: AudioCapableElement;
	buffer: AudioBuffer;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

export function createAudioContext({
	sampleRate,
}: {
	sampleRate?: number;
} = {}): AudioContext {
	const AudioContextConstructor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	return new AudioContextConstructor(sampleRate ? { sampleRate } : undefined);
}

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
}

export async function decodeAudioToFloat32({
	audioBlob,
	sampleRate,
}: {
	audioBlob: Blob;
	sampleRate?: number;
}): Promise<DecodedAudio> {
	const audioContext = createAudioContext({ sampleRate });
	const arrayBuffer = await audioBlob.arrayBuffer();
	const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

	// mix down to mono
	const numChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;
	const samples = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (let channel = 0; channel < numChannels; channel++) {
			sum += audioBuffer.getChannelData(channel)[i];
		}
		samples[i] = sum / numChannels;
	}

	return { samples, sampleRate: audioBuffer.sampleRate };
}

export interface AudibleElementCandidate {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
}

export function collectAudibleCandidates({
	tracks: sceneTracks,
	mediaAssets,
	scenes = [],
	duration = Infinity,
	includeMissingVideo = false,
	silentMissingVideoIds,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	/** All project scenes; needed to mix the audio inside compound clips. */
	scenes?: TScene[];
	duration?: number;
	/** Include enabled video audio even when its file is absent, for export preflight. */
	includeMissingVideo?: boolean;
	silentMissingVideoIds?: ReadonlySet<string>;
}): AudibleElementCandidate[] {
	const tracks = expandCompoundAudioTracks({ tracks: sceneTracks, scenes });
	const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const mediaMap = new Map(mediaAssets.map((a) => [a.id, a]));
	const candidates: AudibleElementCandidate[] = [];

	for (const track of allTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (element.duration <= 0 || element.startTime >= duration || element.startTime + element.duration <= 0) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			const enabled = element.type === "video" && mediaAsset?.type !== "video" && includeMissingVideo
				? !silentMissingVideoIds?.has(element.mediaId) && isSourceAudioEnabled({ element })
				: doesElementHaveEnabledAudio({ element, mediaAsset });
			if (!enabled) continue;

			candidates.push({ element, mediaAsset });
		}
	}

	return candidates;
}

export function timelineHasAudio({
	tracks,
	mediaAssets,
	scenes,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	scenes?: TScene[];
}): boolean {
	return collectAudibleCandidates({ tracks, mediaAssets, scenes }).some(
		({ element }) => !isElementMuted({ element }),
	);
}

export async function collectAudioElements({
	tracks,
	mediaAssets,
	audioContext,
	scenes,
	duration,
	onFailure,
	signal,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	audioContext: AudioContext;
	scenes?: TScene[];
	duration?: number;
	onFailure?: (failure: MediaLoadFailure) => void;
	signal?: AbortSignal;
}): Promise<CollectedAudioElement[]> {
	const candidates = collectAudibleCandidates({ tracks, mediaAssets, scenes, duration });
	const resolved = await Promise.all(candidates.map(async ({ element, mediaAsset }) => {
		signal?.throwIfAborted();
		if (isElementMuted({ element })) return null;
		const buffer = await resolveAudioBufferForElement({ element, mediaAsset, audioContext, onFailure, signal });
		if (!buffer) return null;
		return {
			timelineElement: element,
			buffer,
			startTime: element.startTime / TICKS_PER_SECOND,
			duration: element.duration / TICKS_PER_SECOND,
			trimStart: element.trimStart / TICKS_PER_SECOND,
			trimEnd: element.trimEnd / TICKS_PER_SECOND,
			volume: resolveEffectiveAudioGain({ element, trackMuted: false, localTime: 0 }),
			muted: false,
			retime: element.retime,
		};
	}));
	return resolved.filter((element): element is NonNullable<typeof element> => element !== null);
}

async function resolveAudioBufferForElement({
	element,
	mediaAsset,
	audioContext,
	onFailure,
	signal,
}: {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
	audioContext: AudioContext;
	onFailure?: (failure: MediaLoadFailure) => void;
	signal?: AbortSignal;
}): Promise<AudioBuffer | null> {
	const library = element.type === "audio" && element.sourceType === "library" ? element : null;
	try {
		if (!library) {
			if (!mediaAsset?.file || !mediaSupportsAudio({ media: mediaAsset })) return null;
			if (element.type === "video" && mediaAsset.type !== "video") return null;
			return await resolveAudioBufferForAsset({
				asset: mediaAsset, audioContext, signal,
				requiresAudio: element.type === "audio" || mediaAsset.hasAudio === true,
			});
		}
		if (library.buffer) return library.buffer;
		const response = await fetch(library.sourceUrl, { signal });
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}
		const bytes = await response.arrayBuffer();
		signal?.throwIfAborted();
		return await audioContext.decodeAudioData(bytes);
	} catch (error) {
		signal?.throwIfAborted();
		const message = error instanceof Error ? error.message : String(error);
		if (!onFailure) console.warn("Failed to decode audio:", error);
		else if (library) onFailure({ id: `library:${library.sourceUrl}`, name: library.name, error: message, sourceUrl: library.sourceUrl });
		else if (mediaAsset) onFailure({ id: mediaAsset.id, name: mediaAsset.name, error: message, unreadable: true });
		return null;
	}
}

async function resolveAudioBufferForAsset({
	asset,
	audioContext,
	requiresAudio,
	signal,
}: {
	asset: MediaAsset;
	audioContext: AudioContext;
	requiresAudio: boolean;
	signal?: AbortSignal;
}): Promise<AudioBuffer | null> {
	if (asset.type === "audio") {
		const arrayBuffer = await asset.file.arrayBuffer();
		signal?.throwIfAborted();
		return await audioContext.decodeAudioData(arrayBuffer);
	}

	const input = new Input({
		source: new BlobSource(asset.file),
		formats: ALL_FORMATS,
	});

	const dispose = () => input.dispose();
	signal?.addEventListener("abort", dispose, { once: true });
	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		signal?.throwIfAborted();
		if (!audioTrack) {
			if (requiresAudio) throw new Error("No audio track found");
			return null;
		}

		const sink = new AudioBufferSink(audioTrack);
		const targetSampleRate = audioContext.sampleRate;

		const chunks: AudioBuffer[] = [];
		let totalSamples = 0;

		for await (const { buffer } of sink.buffers(0)) {
			signal?.throwIfAborted();
			chunks.push(buffer);
			totalSamples += buffer.length;
		}

		if (totalSamples === 0) throw new Error("No audio samples could be decoded");

		const nativeSampleRate = chunks[0].sampleRate;
		const numChannels = Math.min(
			MAX_AUDIO_CHANNELS,
			chunks[0].numberOfChannels,
		);

		const nativeChannels = Array.from(
			{ length: numChannels },
			() => new Float32Array(totalSamples),
		);
		let offset = 0;
		for (const chunk of chunks) {
			for (let channel = 0; channel < numChannels; channel++) {
				const sourceData = chunk.getChannelData(
					Math.min(channel, chunk.numberOfChannels - 1),
				);
				nativeChannels[channel].set(sourceData, offset);
			}
			offset += chunk.length;
		}

		// use OfflineAudioContext for high-quality resampling to target rate
		const outputSamples = Math.ceil(
			totalSamples * (targetSampleRate / nativeSampleRate),
		);
		const offlineContext = new OfflineAudioContext(
			numChannels,
			outputSamples,
			targetSampleRate,
		);

		const nativeBuffer = audioContext.createBuffer(
			numChannels,
			totalSamples,
			nativeSampleRate,
		);
		for (let ch = 0; ch < numChannels; ch++) {
			nativeBuffer.copyToChannel(nativeChannels[ch], ch);
		}

		const sourceNode = offlineContext.createBufferSource();
		sourceNode.buffer = nativeBuffer;
		sourceNode.connect(offlineContext.destination);
		sourceNode.start(0);

		return await offlineContext.startRendering();
	} finally {
		signal?.removeEventListener("abort", dispose);
		dispose();
	}
}

interface AudioMixSource {
	timelineElement: AudioCapableElement;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	retime?: RetimeConfig;
}

export interface AudioClipSource {
	timelineElement: AudioCapableElement;
	id: string;
	sourceKey: string;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

async function fetchLibraryAudioSource({
	element,
	volume,
}: {
	element: LibraryAudioElement;
	volume: number;
}): Promise<AudioMixSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			timelineElement: element,
			file,
			startTime: element.startTime / TICKS_PER_SECOND,
			duration: element.duration / TICKS_PER_SECOND,
			trimStart: element.trimStart / TICKS_PER_SECOND,
			trimEnd: element.trimEnd / TICKS_PER_SECOND,
			volume,
			retime: element.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

async function fetchLibraryAudioClip({
	element,
	muted,
	volume,
}: {
	element: LibraryAudioElement;
	muted: boolean;
	volume: number;
}): Promise<AudioClipSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			timelineElement: element,
			id: element.id,
			sourceKey: element.id,
			file,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			volume,
			muted,
			retime: element.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

function collectMediaAudioSource({
	element,
	mediaAsset,
	volume,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset;
	volume: number;
}): AudioMixSource {
	return {
		timelineElement: element,
		file: mediaAsset.file,
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		trimEnd: element.trimEnd / TICKS_PER_SECOND,
		volume,
		retime: element.retime,
	};
}

function collectMediaAudioClip({
	element,
	mediaAsset,
	muted,
	volume,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset;
	muted: boolean;
	volume: number;
}): AudioClipSource {
	return {
		timelineElement: element,
		id: element.id,
		sourceKey: mediaAsset.id,
		file: mediaAsset.file,
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		trimEnd: element.trimEnd / TICKS_PER_SECOND,
		volume,
		muted,
		retime: element.retime,
	};
}

export async function collectAudioMixSources({
	tracks: sceneTracks,
	mediaAssets,
	scenes = [],
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	scenes?: TScene[];
}): Promise<AudioMixSource[]> {
	const tracks = expandCompoundAudioTracks({ tracks: sceneTracks, scenes });
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const audioMixSources: AudioMixSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibrarySources: Array<Promise<AudioMixSource | null>> = [];

	for (const track of orderedTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (isElementMuted({ element })) continue;
			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;
			const volume = resolveEffectiveAudioGain({
				element,
				localTime: 0,
			});

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, volume }),
					);
				} else {
					pendingLibrarySources.push(
						fetchLibraryAudioSource({ element, volume }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				if (mediaAsset && mediaSupportsAudio({ media: mediaAsset })) {
					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, volume }),
					);
				}
			}
		}
	}

	const resolvedLibrarySources = await Promise.all(pendingLibrarySources);
	for (const source of resolvedLibrarySources) {
		if (source) audioMixSources.push(source);
	}

	return audioMixSources;
}

export async function collectAudioClips({
	tracks: sceneTracks,
	mediaAssets,
	scenes = [],
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	scenes?: TScene[];
}): Promise<AudioClipSource[]> {
	const tracks = expandCompoundAudioTracks({ tracks: sceneTracks, scenes });
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const clips: AudioClipSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of orderedTracks) {
		const isTrackMuted = canTrackHaveAudio(track) && track.muted;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;

			const muted = isTrackMuted || isElementMuted({ element });
			const volume = resolveEffectiveAudioGain({
				element,
				trackMuted: isTrackMuted,
				localTime: 0,
			});

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							volume,
						}),
					);
				} else {
					pendingLibraryClips.push(
						fetchLibraryAudioClip({ element, muted, volume }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				if (mediaAsset && mediaSupportsAudio({ media: mediaAsset })) {
					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							volume,
						}),
					);
				}
			}
		}
	}

	const resolvedLibraryClips = await Promise.all(pendingLibraryClips);
	for (const clip of resolvedLibraryClips) {
		if (clip) clips.push(clip);
	}

	return clips;
}

export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
	scenes,
	onFailure,
	signal,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
	audioContext?: AudioContext;
	scenes?: TScene[];
	onFailure?: (failure: MediaLoadFailure) => void;
	signal?: AbortSignal;
}): Promise<AudioBuffer | null> {
	signal?.throwIfAborted();
	const context = audioContext ?? createAudioContext({ sampleRate });
	const closeContext = () => {
		if (!audioContext && context.state !== "closed") {
			void context.close().catch((error) => console.warn("Failed to close audio context:", error));
		}
	};
	signal?.addEventListener("abort", closeContext, { once: true });
	try {
		const audioElements = await collectAudioElements({
			tracks, mediaAssets, audioContext: context, scenes, duration, onFailure, signal,
		});
		signal?.throwIfAborted();
		if (audioElements.length === 0) return null;

		const outputLength = Math.ceil((duration / TICKS_PER_SECOND) * sampleRate);
		const outputBuffer = context.createBuffer(MAX_AUDIO_CHANNELS, outputLength, sampleRate);
		for (const element of audioElements) {
			signal?.throwIfAborted();
			if (element.muted) continue;

			const renderedBuffer = shouldMaintainPitch({
				rate: element.retime?.rate ?? 1,
				maintainPitch: element.retime?.maintainPitch,
			})
				? await renderRetimedBuffer({
						audioContext: context,
						sourceBuffer: element.buffer,
						trimStart: element.trimStart,
						clipDuration: element.duration,
						retime: element.retime,
						maintainPitch: true,
					})
				: undefined;
			signal?.throwIfAborted();

			mixAudioChannels({
				element,
				buffer: renderedBuffer ?? element.buffer,
				trimStart: renderedBuffer ? 0 : element.trimStart,
				retime: renderedBuffer ? undefined : element.retime,
				outputBuffer,
				outputLength,
				sampleRate,
			});
		}
		return await applyAudioMasteringToBuffer({ audioBuffer: outputBuffer });
	} finally {
		signal?.removeEventListener("abort", closeContext);
		if (!signal?.aborted) closeContext();
	}
}

function collectPeakRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): Float32Array {
	const channels = buffer.numberOfChannels;
	const peaks = new Float32Array(count);

	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i < count; i++) {
			const { bucketStart: start, bucketEnd: end } = getSampleBucketRange({
				startSample,
				endSample,
				bucketIndex: i,
				bucketCount: count,
			});
			for (let j = start; j < end; j++) {
				const abs = Math.abs(data[j]);
				if (abs > peaks[i]) peaks[i] = abs;
			}
		}
	}

	return peaks;
}

export function extractPeakRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): number[] {
	return Array.from(
		collectPeakRange({
			buffer,
			count,
			startSample,
			endSample,
		}),
	);
}

export function getSampleBucketRange({
	startSample,
	endSample,
	bucketIndex,
	bucketCount,
}: {
	startSample: number;
	endSample: number;
	bucketIndex: number;
	bucketCount: number;
}): {
	bucketStart: number;
	bucketEnd: number;
} {
	const rangeLength = Math.max(0, endSample - startSample);
	const bucketStart =
		startSample + Math.floor((bucketIndex * rangeLength) / bucketCount);
	const bucketEnd =
		startSample + Math.floor(((bucketIndex + 1) * rangeLength) / bucketCount);
	return {
		bucketStart,
		bucketEnd: Math.max(bucketStart, bucketEnd),
	};
}

export function extractRmsBuckets({
	buffer,
	buckets,
}: {
	buffer: AudioBuffer;
	buckets: SampleBucket[];
}): number[] {
	return computeRmsBuckets({ buffer, buckets });
}

/**
 * Computes per-bucket waveform amplitude using the maximum RMS over a short
 * analysis window inside each bucket.
 *
 * A naive mean-RMS over a whole bucket averages silence together with nearby
 * sound, which smears transitions (e.g. the onset of speech) across the
 * bucket and makes the waveform respond late. Taking the max over fixed
 * short windows (~20 ms) preserves the smooth, non-jittery RMS character
 * while making transitions land where they actually happen in the audio.
 *
 * Channels are combined per-window before taking the max, so the measure
 * reflects total energy regardless of stereo layout.
 */
export function extractRmsRange({
	buffer,
	count,
	startSample,
	endSample,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
}): number[] {
	return extractRmsBuckets({
		buffer,
		buckets: Array.from({ length: count }, (_, bucketIndex) =>
			getSampleBucketRange({
				startSample,
				endSample,
				bucketIndex,
				bucketCount: count,
			}),
		),
	});
}

function mixAudioChannels({
	element,
	buffer,
	trimStart,
	retime,
	outputBuffer,
	outputLength,
	sampleRate,
}: {
	element: CollectedAudioElement;
	buffer: AudioBuffer;
	trimStart: number;
	retime?: RetimeConfig;
	outputBuffer: AudioBuffer;
	outputLength: number;
	sampleRate: number;
}): void {
	const { startTime, duration: elementDuration } = element;

	const outputStartSample = Math.floor(startTime * sampleRate);
	const renderedLength = Math.ceil(elementDuration * sampleRate);

	const outputChannels = 2;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = outputBuffer.getChannelData(channel);
		const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
		const sourceData = buffer.getChannelData(sourceChannel);

		for (let i = 0; i < renderedLength; i++) {
			const outputIndex = outputStartSample + i;
			if (outputIndex >= outputLength) break;

			const clipTime = i / sampleRate;
			const sourceTime =
				trimStart + getSourceTimeAtClipTime({ clipTime, retime });
			const sourceIndex = sourceTime * buffer.sampleRate;
			if (sourceIndex >= sourceData.length) break;

			const lowerIndex = Math.floor(sourceIndex);
			const upperIndex = Math.min(sourceData.length - 1, lowerIndex + 1);
			const fraction = sourceIndex - lowerIndex;
			const gain = hasAnimatedVolume({ element: element.timelineElement })
				? resolveEffectiveAudioGain({
						element: element.timelineElement,
						localTime: clipTime,
					})
				: element.volume;
			outputData[outputIndex] +=
				(sourceData[lowerIndex] * (1 - fraction) +
					sourceData[upperIndex] * fraction) *
				gain;
		}
	}
}
