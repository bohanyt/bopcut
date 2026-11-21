import type {
	AudioElement,
	VideoElement,
	LibraryAudioElement,
	RetimeConfig,
	SceneTracks,
	TScene,
} from "@/timeline";
import { expandCompoundAudioTracks } from "@/timeline/compound";
import type { MediaAsset } from "@/media/types";
import type { AudioCapableElement } from "@/timeline/audio-state";
import {
	isElementMuted,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { doesElementHaveEnabledAudio, isSourceAudioEnabled } from "@/timeline/audio-separation";
import { canElementHaveAudio, hasMediaId } from "@/timeline/element-utils";
import { canTrackHaveAudio } from "@/timeline";
import { mediaSupportsAudio } from "@/media/media-utils";
import { TICKS_PER_SECOND } from "@/wasm";
import {
	computeRmsBuckets,
	type SampleBucket,
} from "@/media/waveform-summary";

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

export async function decodeAudioBuffer({
	arrayBuffer,
	sampleRate,
}: {
	arrayBuffer: ArrayBuffer;
	sampleRate?: number;
}): Promise<AudioBuffer> {
	const audioContext = createAudioContext({ sampleRate });
	try {
		return await audioContext.decodeAudioData(arrayBuffer);
	} finally {
		await audioContext.close().catch((error) => {
			console.warn("Failed to close audio context:", error);
		});
	}
}

export async function decodeAudioToFloat32({
	audioBlob,
	sampleRate,
}: {
	audioBlob: Blob;
	sampleRate?: number;
}): Promise<DecodedAudio> {
	const arrayBuffer = await audioBlob.arrayBuffer();
	const audioBuffer = await decodeAudioBuffer({ arrayBuffer, sampleRate });

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

export function resolvePitchSourceEnd(element: AudioCapableElement, rate: number): {
	sourceEnd: number;
	boundSourceEnd?: boolean;
} {
	const sourceSpan = element.duration * rate;
	const projectedEnd = (element.trimStart + sourceSpan) / TICKS_PER_SECOND;
	if (element.sourceDuration !== undefined) {
		const storedEnd = element.sourceDuration - element.trimEnd;
		const storedSpan = storedEnd - element.trimStart;
		// Allow timeline and source tick rounding, or one 48 kHz frame for split drift.
		const tolerance = Math.max(rate / 2 + 1, TICKS_PER_SECOND / 48_000);
		if (sourceSpan - storedSpan > tolerance) {
			// A short stored span can come from valid edits or stale duration metadata.
			// Keep the original trailing reads until the timeline can distinguish them.
			return { sourceEnd: projectedEnd, boundSourceEnd: false };
		}
		if (storedSpan > 0 && storedSpan <= sourceSpan + tolerance) {
			return { sourceEnd: storedEnd / TICKS_PER_SECOND };
		}
	}
	return { sourceEnd: projectedEnd };
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
	signal,
}: {
	element: LibraryAudioElement;
	volume: number;
	signal?: AbortSignal;
}): Promise<AudioMixSource | null> {
	try {
		const response = await fetch(element.sourceUrl, { signal });
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
		if (!signal?.aborted) console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

async function fetchLibraryAudioClip({
	element,
	muted,
	volume,
	signal,
}: {
	element: LibraryAudioElement;
	muted: boolean;
	volume: number;
	signal?: AbortSignal;
}): Promise<AudioClipSource | null> {
	const source = await fetchLibraryAudioSource({ element, volume, signal });
	return source && { ...source, id: element.id, sourceKey: element.id, muted };
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
		...collectMediaAudioSource({ element, mediaAsset, volume }),
		id: element.id,
		sourceKey: mediaAsset.id,
		muted,
	};
}

export async function collectAudioClips({
	tracks: sceneTracks,
	mediaAssets,
	scenes = [],
	signal,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	scenes?: TScene[];
	signal?: AbortSignal;
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
						fetchLibraryAudioClip({ element, muted, volume, signal }),
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
