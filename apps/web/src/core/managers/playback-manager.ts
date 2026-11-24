import type { EditorCore } from "@/core";
import {
	PLAYBACK_STATE,
	PLAYBACK_TIME,
	recordPlaybackRead,
} from "@/core/playback-reads";
import {
	clampMediaTime,
	type MediaTime,
	mediaTimeFromSeconds,
	roundFrameTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";

const wallClock = () => performance.now() / 1000;

export class PlaybackManager {
	private isPlaying = false;
	private currentTime: MediaTime = ZERO_MEDIA_TIME;
	private volume = 1;
	private muted = false;
	private recordingMute = false;
	private previousVolume = 1;
	private isScrubbing = false;
	private listeners = new Set<() => void>();
	private stateListeners = new Set<() => void>();
	private updateListeners = new Set<(time: MediaTime) => void>();
	private seekListeners = new Set<(time: MediaTime) => void>();
	private interruptListeners = new Set<() => void>();
	private revealListeners = new Set<() => void>();
	private playbackTimer: number | null = null;
	private readClock = wallClock;
	private playbackStartClockTime = 0;
	private playbackStartTime = 0;
	private timelineScopeBound = false;

	constructor(private editor: EditorCore) {}

	bindTimelineScope(): void {
		if (this.timelineScopeBound) {
			return;
		}

		const reconcile = () => {
			this.reconcileTimelineScope();
		};
		this.editor.timeline.subscribe(reconcile);
		this.editor.scenes.subscribe(reconcile);
		this.timelineScopeBound = true;
		this.reconcileTimelineScope();
	}

	play({ restartAtEnd = true } = {}): void {
		if (this.isPlaying) return;
		const maxTime = this.editor.timeline.getTotalDuration();
		if (maxTime <= 0) {
			return;
		}

		if (this.currentTime >= maxTime) {
			if (!restartAtEnd) return;
			this.setTime(ZERO_MEDIA_TIME);
		}

		this.isPlaying = true;
		this.startTimer();
		this.notify();
	}

	pause(): void {
		this.interruptListeners.forEach((fn) => fn());
		this.pausePlayback();
	}

	private pausePlayback(): void {
		this.isPlaying = false;
		this.stopTimer();
		this.notify();
	}

	finishAtTimelineEnd(): void {
		const endTime = this.editor.timeline.getTotalDuration();
		this.pausePlayback();
		this.setTime(endTime);
		this.dispatchSeekEvent(this.currentTime);
	}

	toggle(): void {
		if (this.isPlaying) {
			this.pause();
		} else {
			this.play();
		}
	}

	seek({ time }: { time: MediaTime }): void {
		this.interruptListeners.forEach((fn) => fn());
		this.setTime(time);
		this.persistPlayheadViewState();
	}

	private persistPlayheadViewState(): void {
		if (this.isPlaying || this.isScrubbing) return;
		this.editor.project.scheduleTimelineViewStatePlayhead({
			playheadTime: this.currentTime,
		});
	}

	private setTime(time: MediaTime): void {
		this.currentTime = this.clampTimeToTimeline(time);
		if (this.isPlaying) {
			this.playbackStartClockTime = this.readClock();
			this.playbackStartTime = this.currentTime / TICKS_PER_SECOND;
		}
		this.notify({ stateChanged: false });
		this.notifySeek(this.currentTime);
	}

	setVolume({ volume }: { volume: number }): void {
		const clampedVolume = Math.max(0, Math.min(1, volume));
		this.volume = clampedVolume;
		this.muted = clampedVolume === 0;
		if (clampedVolume > 0) {
			this.previousVolume = clampedVolume;
		}
		this.notify();
	}

	mute(): void {
		if (this.volume > 0) {
			this.previousVolume = this.volume;
		}
		this.muted = true;
		this.volume = 0;
		this.notify();
	}

	unmute(): void {
		this.muted = false;
		this.volume = this.previousVolume;
		this.notify();
	}

	toggleMute(): void {
		if (this.muted) {
			this.unmute();
		} else {
			this.mute();
		}
	}

	getIsPlaying(): boolean {
		recordPlaybackRead(PLAYBACK_STATE);
		return this.isPlaying;
	}

	getCurrentTime(): MediaTime {
		recordPlaybackRead(PLAYBACK_TIME);
		return this.currentTime;
	}

	getPlaybackTime(): number {
		recordPlaybackRead(PLAYBACK_STATE | PLAYBACK_TIME);
		if (!this.isPlaying) return this.currentTime / TICKS_PER_SECOND;
		return this.playbackStartTime + (this.readClock() - this.playbackStartClockTime);
	}

	setPlaybackClock(readClock = wallClock): { timelineTime: number; clockTime: number } {
		const timelineTime = this.getPlaybackTime();
		const clockTime = readClock();
		this.readClock = readClock;
		this.playbackStartTime = timelineTime;
		this.playbackStartClockTime = clockTime;
		return { timelineTime, clockTime };
	}

	getVolume(): number {
		recordPlaybackRead(PLAYBACK_STATE);
		return this.volume;
	}

	getOutputVolume(): number {
		recordPlaybackRead(PLAYBACK_STATE);
		return this.recordingMute ? 0 : this.volume;
	}

	muteDuringRecording(): () => void {
		this.recordingMute = true;
		this.notify();
		return () => {
			this.recordingMute = false;
			this.notify();
		};
	}

	isMuted(): boolean {
		recordPlaybackRead(PLAYBACK_STATE);
		return this.muted;
	}

	setScrubbing({ isScrubbing }: { isScrubbing: boolean }): void {
		this.isScrubbing = isScrubbing;
		this.notify();
	}

	getIsScrubbing(): boolean {
		recordPlaybackRead(PLAYBACK_STATE);
		return this.isScrubbing;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	subscribeState(listener: () => void): () => void {
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	subscribeTime(listener: () => void): () => void {
		const stopSeeking = this.onSeek(listener);
		const stopPlaying = this.onUpdate(listener);
		return () => {
			stopSeeking();
			stopPlaying();
		};
	}

	onUpdate(listener: (time: MediaTime) => void): () => void {
		this.updateListeners.add(listener);
		return () => this.updateListeners.delete(listener);
	}

	onSeek(listener: (time: MediaTime) => void): () => void {
		this.seekListeners.add(listener);
		return () => this.seekListeners.delete(listener);
	}

	/** Asks the timeline to scroll the playhead into view. */
	revealPlayhead(): void {
		this.revealListeners.forEach((fn) => fn());
	}

	onReveal(listener: () => void): () => void {
		this.revealListeners.add(listener);
		return () => this.revealListeners.delete(listener);
	}

	/** Explicit pause or seek, independent of natural ends and timeline reconciliation. */
	onPlaybackInterrupt(listener: () => void): () => void {
		this.interruptListeners.add(listener);
		return () => this.interruptListeners.delete(listener);
	}

	private reconcileTimelineScope(): void {
		const maxTime = this.editor.timeline.getTotalDuration();
		const nextTime = this.clampTimeToTimeline(this.currentTime);
		const shouldPause = this.isPlaying && nextTime >= maxTime;
		const timeChanged = nextTime !== this.currentTime;

		if (!timeChanged && !shouldPause) {
			return;
		}

		if (shouldPause) {
			this.isPlaying = false;
			this.stopTimer();
		}

		this.currentTime = nextTime;
		this.notify({ stateChanged: shouldPause });

		if (timeChanged) {
			this.notifySeek(this.currentTime);
			this.dispatchSeekEvent(this.currentTime);
		}
	}

	private notify({ stateChanged = true } = {}): void {
		this.listeners.forEach((fn) => {
			fn();
		});
		if (stateChanged) this.stateListeners.forEach((fn) => fn());
	}

	private notifyUpdate(time: MediaTime): void {
		this.updateListeners.forEach((fn) => {
			fn(time);
		});
	}

	private notifySeek(time: MediaTime): void {
		this.seekListeners.forEach((fn) => {
			fn(time);
		});
	}

	private startTimer(): void {
		if (this.playbackTimer) {
			cancelAnimationFrame(this.playbackTimer);
		}

		this.playbackStartClockTime = this.readClock();
		this.playbackStartTime = this.currentTime / TICKS_PER_SECOND;
		this.updateTime();
	}

	private stopTimer(): void {
		if (this.playbackTimer) {
			cancelAnimationFrame(this.playbackTimer);
			this.playbackTimer = null;
		}
	}

	private updateTime = (): void => {
		if (!this.isPlaying) return;

		const fps = this.editor.project.getActiveOrNull()?.settings.fps;
		const rawTime = mediaTimeFromSeconds({ seconds: this.getPlaybackTime() });
		const maxTime = this.editor.timeline.getTotalDuration();

		if (rawTime >= maxTime) {
			this.finishAtTimelineEnd();
		return;
		}

		const newTime = clampMediaTime({
			time: fps ? roundFrameTime({ time: rawTime, fps }) : rawTime,
			min: ZERO_MEDIA_TIME,
			max: maxTime,
		});
		this.currentTime = newTime;
		this.notifyUpdate(newTime);
		this.dispatchUpdateEvent(newTime);
		this.playbackTimer = requestAnimationFrame(this.updateTime);
	};

	private clampTimeToTimeline(time: MediaTime): MediaTime {
		const maxTime = this.editor.timeline.getTotalDuration();
		return clampMediaTime({ time, min: ZERO_MEDIA_TIME, max: maxTime });
	}

	private dispatchSeekEvent(time: MediaTime): void {
		if (typeof window === "undefined") {
			return;
		}
	}

	private dispatchUpdateEvent(time: MediaTime): void {
		if (typeof window === "undefined") {
			return;
		}
	}
}
