import type { EditorCore } from "@/core";
import { clampRetimeRate, shouldMaintainPitch } from "@/retime/rate";
import type { AudioClipSource } from "@/media/audio";
import { createAudioContext, collectAudioClips } from "@/media/audio";
import { buildAudioGainAutomation, hasAnimatedVolume, hasVolumeKeyframes } from "@/timeline/audio-state";
import { createAudioMasteringChain } from "@/media/audio-mastering";
import { renderRetimedBuffer } from "@/retime";
import {
	ALL_FORMATS,
	AudioBufferSink,
	BlobSource,
	Input,
	type WrappedAudioBuffer,
} from "mediabunny";

const LOOKAHEAD_SECONDS = 2;
const SCHEDULE_STEP_SECONDS = 0.5;
const STREAM_AHEAD_SECONDS = 1;

export class AudioManager {
	private audioContext: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private playbackAnchor: { timelineTime: number; clockTime: number } | null = null;
	private nextScheduleTime = 0;
	private clips: AudioClipSource[] = [];
	private sinks = new Map<string, Promise<AudioBufferSink | null>>();
	private inputs = new Map<string, Input>();
	private activeClipIds = new Set<string>();
	private clipIterators = new Map<
		string,
		AsyncGenerator<WrappedAudioBuffer, void, unknown>
	>();
	private streamWaiters = new Set<{ resumeAt: number; resolve: () => void }>();
	private queuedSources = new Map<AudioBufferSourceNode, GainNode>();
	private preparedClipBuffers = new Map<string, Promise<AudioBuffer | null>>();
	private decodedBuffers = new Map<string, Promise<AudioBuffer | null>>();
	private decodingInputs = new Set<Input>();
	private playbackSession: AbortController | null = null;
	private lastIsPlaying = false;
	private lastVolume = 1;
	private unsubscribers: Array<() => void> = [];

	constructor(private editor: EditorCore) {
		this.lastVolume = this.editor.playback.getVolume();

		this.unsubscribers.push(
			this.editor.playback.subscribe(this.handlePlaybackChange),
			this.editor.timeline.subscribe(this.handleTimelineChange),
			this.editor.media.subscribe(this.handleTimelineChange),
			this.editor.playback.onSeek(this.handleSeek),
			this.editor.playback.onUpdate(this.handlePlaybackUpdate),
		);
	}

	dispose(): void {
		this.stopPlayback({ suspend: false });
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
		this.disposeSinks();
		if (this.audioContext) {
			void this.audioContext.close().catch((error) => {
				console.warn("Failed to close preview audio:", error);
			});
			this.audioContext = null;
			this.masterGain = null;
		}
	}

	private handlePlaybackChange = (): void => {
		const isPlaying = this.editor.playback.getIsPlaying();
		const volume = this.editor.playback.getVolume();

		if (volume !== this.lastVolume) {
			this.lastVolume = volume;
			this.updateGain();
		}

		if (isPlaying !== this.lastIsPlaying) {
			this.lastIsPlaying = isPlaying;
			if (isPlaying) {
				void this.startPlayback();
			} else {
				this.stopPlayback();
			}
		}
	};

	private handleSeek = (): void => {
		if (this.editor.playback.getIsPlaying() && !this.editor.playback.getIsScrubbing()) {
			void this.startPlayback();
		} else {
			this.stopPlayback();
		}
	};

	private handleTimelineChange = (): void => {
		this.disposeSinks();

		if (this.editor.playback.getIsPlaying() && !this.editor.playback.getIsScrubbing()) {
			void this.startPlayback();
		}
	};

	private handlePlaybackUpdate = (): void => {
		if (!this.playbackAnchor) return;

		const time = this.editor.playback.getPlaybackTime();
		for (const waiter of this.streamWaiters) {
			if (time >= waiter.resumeAt) {
				this.streamWaiters.delete(waiter);
				waiter.resolve();
			}
		}
		if (time >= this.nextScheduleTime) this.scheduleUpcomingClips(time);
	};

	private ensureAudioContext(): AudioContext | null {
		if (this.audioContext) return this.audioContext;
		if (typeof window === "undefined") return null;

		this.audioContext = createAudioContext();
		const { input } = createAudioMasteringChain({
			audioContext: this.audioContext,
			destination: this.audioContext.destination,
		});
		this.masterGain = input;
		this.masterGain.gain.value = this.lastVolume;
		return this.audioContext;
	}

	private updateGain(): void {
		if (!this.masterGain) return;
		this.masterGain.gain.value = this.lastVolume;
	}

	private async startPlayback(): Promise<void> {
		this.stopPlayback({ suspend: false });
		const scene = this.editor.scenes.getActiveSceneOrNull();
		if (!scene || this.editor.timeline.getTotalDuration() <= 0 || this.editor.playback.getIsScrubbing()) {
			this.suspendAudioContext();
			return;
		}

		const session = new AbortController();
		this.playbackSession = session;
		const { signal } = session;
		try {
			const audioContext = this.ensureAudioContext();
			if (!audioContext) return;

			// Resume even if a pending suspend has not changed the reported state yet.
			await audioContext.resume();
			if (signal.aborted) return;

			const clips = await collectAudioClips({
				tracks: scene.tracks,
				mediaAssets: this.editor.media.getAssets(),
				scenes: this.editor.scenes.getScenes(),
				signal,
			});
			if (signal.aborted) return;
			this.clips = clips.filter((clip) => !clip.muted);
			if (this.clips.length === 0) {
				this.stopPlayback();
				return;
			}

			// Transfer the current unrounded playhead to the audio clock after startup.
			this.playbackAnchor = this.editor.playback.setPlaybackClock(() => audioContext.currentTime);
			this.scheduleUpcomingClips(this.playbackAnchor.timelineTime);
		} catch (error) {
			if (signal.aborted) return;
			console.warn("Failed to start preview audio:", error);
			this.stopPlayback();
		}
	}

	private scheduleUpcomingClips(currentTime: number): void {
		const signal = this.playbackSession?.signal;
		if (!signal) return;
		this.nextScheduleTime = currentTime + SCHEDULE_STEP_SECONDS;
		const windowEnd = currentTime + LOOKAHEAD_SECONDS;

		for (const clip of this.clips) {
			if (this.activeClipIds.has(clip.id)) continue;
			if (clip.startTime + clip.duration <= currentTime || clip.startTime > windowEnd) continue;

			this.activeClipIds.add(clip.id);
			const task = this.shouldUsePreparedClipBuffer({ clip })
				? this.schedulePreparedClip({ clip, signal })
				: this.runClipIterator({ clip, signal });
			void task.catch((error) => {
				if (!signal.aborted) console.warn("Failed to play clip audio:", error);
			});
		}
	}

	private stopPlayback({ suspend = true } = {}): void {
		const hadSession = this.playbackSession !== null;
		this.playbackSession?.abort();
		this.playbackSession = null;
		if (this.playbackAnchor) {
			this.editor.playback.setPlaybackClock();
			this.playbackAnchor = null;
		}

		for (const waiter of this.streamWaiters) waiter.resolve();
		this.streamWaiters.clear();
		for (const iterator of this.clipIterators.values()) {
			void iterator.return().catch(() => {});
		}
		this.clipIterators.clear();
		this.activeClipIds.clear();
		this.clips = [];

		for (const [source, gain] of this.queuedSources) {
			source.stop();
			source.disconnect();
			gain.disconnect();
		}
		this.queuedSources.clear();
		if (suspend && hadSession) this.suspendAudioContext();
	}

	private suspendAudioContext(): void {
		void this.audioContext?.suspend().catch((error) => {
			console.warn("Failed to suspend preview audio:", error);
		});
	}

	private async runClipIterator({
		clip,
		signal,
	}: {
		clip: AudioClipSource;
		signal: AbortSignal;
	}): Promise<void> {
		const sink = await this.getAudioSink({ clip });
		if (!sink || signal.aborted) return;

		const rate = clampRetimeRate({ rate: clip.retime?.rate ?? 1 });
		const localStart = Math.max(0, this.editor.playback.getPlaybackTime() - clip.startTime);
		if (localStart >= clip.duration) return;
		const iterator = sink.buffers(clip.trimStart + localStart * rate, clip.trimStart + clip.duration * rate);
		this.clipIterators.set(clip.id, iterator);
		try {
			for await (const { buffer, timestamp } of iterator) {
				if (signal.aborted) break;

				const bufferLocalTime = (timestamp - clip.trimStart) / rate;
				if (bufferLocalTime >= clip.duration) break;
				const resumeAt = clip.startTime + bufferLocalTime - STREAM_AHEAD_SECONDS;
				if (resumeAt > this.editor.playback.getPlaybackTime()) {
					await new Promise<void>((resolve) => this.streamWaiters.add({ resumeAt, resolve }));
					if (signal.aborted) break;
				}
				this.scheduleBuffer({ clip, buffer, bufferLocalTime, rate });
			}
		} finally {
			if (this.clipIterators.get(clip.id) === iterator) this.clipIterators.delete(clip.id);
		}
	}

	private async schedulePreparedClip({
		clip,
		signal,
	}: {
		clip: AudioClipSource;
		signal: AbortSignal;
	}): Promise<void> {
		const buffer = await this.getPreparedClipBuffer({ clip });
		if (!buffer || signal.aborted) return;
		this.scheduleBuffer({ clip, buffer, bufferLocalTime: 0, rate: 1 });
	}

	private scheduleBuffer({
		clip,
		buffer,
		bufferLocalTime,
		rate,
	}: {
		clip: AudioClipSource;
		buffer: AudioBuffer;
		bufferLocalTime: number;
		rate: number;
	}): void {
		const audioContext = this.audioContext;
		const anchor = this.playbackAnchor;
		if (!audioContext || !anchor) return;

		const clipTimestamp = anchor.clockTime + (clip.startTime - anchor.timelineTime);
		const now = audioContext.currentTime;
		const startLocalTime = Math.max(0, bufferLocalTime, now - clipTimestamp);
		const endLocalTime = Math.min(clip.duration, bufferLocalTime + buffer.duration / rate);
		if (startLocalTime >= endLocalTime) return;

		const startTimestamp = Math.max(now, clipTimestamp + startLocalTime);
		const offset = (startLocalTime - bufferLocalTime) * rate;
		const duration = (endLocalTime - startLocalTime) * rate;

		const node = audioContext.createBufferSource();
		node.buffer = buffer;
		node.playbackRate.value = rate;
		const clipGain = audioContext.createGain();
		clipGain.gain.value = clip.volume;
		if (hasAnimatedVolume({ element: clip.timelineElement })) {
			const [first, ...rest] = buildAudioGainAutomation({
				element: clip.timelineElement,
				fromLocalTime: startLocalTime,
				toLocalTime: endLocalTime,
			});
			clipGain.gain.setValueAtTime(first.gain, startTimestamp);
			for (const { localTime, gain } of rest) {
				clipGain.gain.linearRampToValueAtTime(gain, startTimestamp + (localTime - startLocalTime));
			}
		}

		node.connect(clipGain);
		clipGain.connect(this.masterGain ?? audioContext.destination);
		node.start(startTimestamp, offset, duration);
		this.queuedSources.set(node, clipGain);
		node.addEventListener("ended", () => {
			if (!this.queuedSources.delete(node)) return;
			node.disconnect();
			clipGain.disconnect();
		}, { once: true });
	}

	private disposeSinks(): void {
		for (const input of this.inputs.values()) {
			input.dispose();
		}
		this.inputs.clear();
		this.sinks.clear();
		for (const input of this.decodingInputs) input.dispose();
		this.decodingInputs.clear();
		this.preparedClipBuffers.clear();
		this.decodedBuffers.clear();
	}

	private shouldUsePreparedClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): boolean {
		return (
			this.hasCurveRetime({ clip }) ||
			hasVolumeKeyframes({ element: clip.timelineElement }) ||
			shouldMaintainPitch({
				rate: clip.retime?.rate ?? 1,
				maintainPitch: clip.retime?.maintainPitch,
			})
		);
	}

	private hasCurveRetime({ clip }: { clip: AudioClipSource }): boolean {
		const mode = (clip.retime as { mode?: unknown } | undefined)?.mode;
		return mode === "curve";
	}

	private buildPreparedClipCacheKey({
		clip,
	}: {
		clip: AudioClipSource;
	}): string {
		return JSON.stringify({
			id: clip.id,
			sourceKey: clip.sourceKey,
			startTime: clip.startTime,
			duration: clip.duration,
			trimStart: clip.trimStart,
			trimEnd: clip.trimEnd,
			retime: clip.retime ?? null,
		});
	}

	private async getPreparedClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const cacheKey = this.buildPreparedClipCacheKey({ clip });
		const existing = this.preparedClipBuffers.get(cacheKey);
		if (existing) {
			return existing;
		}

		const promise = (async () => {
			const audioContext = this.ensureAudioContext();
			if (!audioContext) {
				return null;
			}

			const decodedBuffer = await this.getDecodedBuffer({ clip });
			if (!decodedBuffer) {
				return null;
			}

			return await renderRetimedBuffer({
				audioContext,
				sourceBuffer: decodedBuffer,
				trimStart: clip.trimStart,
				clipDuration: clip.duration,
				retime: clip.retime,
				maintainPitch: clip.retime?.maintainPitch === true,
			});
		})();

		this.preparedClipBuffers.set(cacheKey, promise);
		return promise;
	}

	private async getDecodedBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const existing = this.decodedBuffers.get(clip.sourceKey);
		if (existing) {
			return existing;
		}

		const promise = this.decodeClipBuffer({ clip });
		this.decodedBuffers.set(clip.sourceKey, promise);
		return promise;
	}

	private async decodeClipBuffer({
		clip,
	}: {
		clip: AudioClipSource;
	}): Promise<AudioBuffer | null> {
		const audioContext = this.ensureAudioContext();
		if (!audioContext) {
			return null;
		}

		const input = new Input({
			source: new BlobSource(clip.file),
			formats: ALL_FORMATS,
		});
		this.decodingInputs.add(input);

		try {
			const audioTrack = await input.getPrimaryAudioTrack();
			if (!audioTrack || !this.decodingInputs.has(input)) {
				return null;
			}

			const sink = new AudioBufferSink(audioTrack);
			const chunks: AudioBuffer[] = [];
			let totalSamples = 0;

			for await (const { buffer } of sink.buffers(0)) {
				chunks.push(buffer);
				totalSamples += buffer.length;
			}

			if (chunks.length === 0 || !this.decodingInputs.has(input)) {
				return null;
			}

			const targetSampleRate = audioContext.sampleRate;
			const nativeSampleRate = chunks[0].sampleRate;
			const numChannels = Math.min(2, chunks[0].numberOfChannels);
			const nativeChannels = Array.from(
				{ length: numChannels },
				() => new Float32Array(totalSamples),
			);

			let offset = 0;
			for (const chunk of chunks) {
				for (let channel = 0; channel < numChannels; channel++) {
					nativeChannels[channel].set(
						chunk.getChannelData(Math.min(channel, chunk.numberOfChannels - 1)),
						offset,
					);
				}
				offset += chunk.length;
			}

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

			for (let channel = 0; channel < numChannels; channel++) {
				nativeBuffer.copyToChannel(nativeChannels[channel], channel);
			}

			const sourceNode = offlineContext.createBufferSource();
			sourceNode.buffer = nativeBuffer;
			sourceNode.connect(offlineContext.destination);
			sourceNode.start(0);

			return await offlineContext.startRendering();
		} catch (error) {
			if (this.decodingInputs.has(input)) console.warn("Failed to decode clip audio:", error);
			return null;
		} finally {
			if (this.decodingInputs.delete(input)) input.dispose();
		}
	}

	private getAudioSink({ clip }: { clip: AudioClipSource }): Promise<AudioBufferSink | null> {
		const existing = this.sinks.get(clip.sourceKey);
		if (existing) return existing;

		const input = new Input({
			source: new BlobSource(clip.file),
			formats: ALL_FORMATS,
		});
		this.inputs.set(clip.sourceKey, input);
		const pending = this.openAudioSink({ input, sourceKey: clip.sourceKey });
		this.sinks.set(clip.sourceKey, pending);
		return pending;
	}

	private async openAudioSink({
		input,
		sourceKey,
	}: {
		input: Input;
		sourceKey: string;
	}): Promise<AudioBufferSink | null> {
		try {
			const track = await input.getPrimaryAudioTrack();
			if (this.inputs.get(sourceKey) !== input) return null;
			if (track) return new AudioBufferSink(track);
		} catch (error) {
			if (this.inputs.get(sourceKey) !== input) return null;
			console.warn("Failed to initialize audio sink:", error);
		}

		input.dispose();
		this.inputs.delete(sourceKey);
		this.sinks.delete(sourceKey);
		return null;
	}

}
