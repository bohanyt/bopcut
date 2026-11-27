import type { PointerEvent as ReactPointerEvent } from "react";
import type { FrameRate } from "opencut-wasm";
import {
	mediaTime,
	snapSeekMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";
import {
	buildSnapIndex,
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveIndexedSnap,
	type SnapIndex,
} from "@/timeline/snapping";
import { getBookmarkSnapPoints } from "@/timeline/bookmarks/snap-source";
import { getElementEdgeSnapPoints } from "@/timeline/element-snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import { startEdgeAutoScroll } from "@/timeline/edge-auto-scroll";
import {
	getCenteredLineLeft,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/timeline";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import type { Bookmark, SceneTracks } from "@/timeline";

// --- Session ---

interface ScrubSession {
	kind: "scrubbing";
	/** True when scrub started from a ruler click (not the playhead handle). */
	didStartFromRuler: boolean;
	/** True once the pointer has moved since the press. */
	hasMoved: boolean;
	pointerId: number;
	captureTarget: Element;
	projectSession: number;
	sceneId: string | undefined;
	snapCache?: {
		tracks: SceneTracks;
		bookmarks: Bookmark[];
		index: SnapIndex;
	};
}

type Session = { kind: "idle" } | ScrubSession;

// --- Config ---

export interface PlayheadConfig {
	zoomLevel: number;
	getDuration: () => MediaTime;
	getProjectSession: () => number;
	getSceneId: () => string | undefined;
	getCurrentTime: () => MediaTime;
	getActiveProjectFps: () => FrameRate | null;
	isShiftHeld: () => boolean;
	isSnappingEnabled: () => boolean;
	getIsPlaying: () => boolean;
	getRulerEl: () => HTMLDivElement | null;
	getRulerScrollEl: () => HTMLDivElement | null;
	getTracksScrollEl: () => HTMLDivElement | null;
	getPlayheadEl: () => HTMLDivElement | null;
	getSceneTracks: () => SceneTracks;
	getSceneBookmarks: () => Bookmark[];
	seek: (time: MediaTime) => void;
	pause: () => void;
	setScrubbing: (isScrubbing: boolean) => void;
	setTimelineViewState: (viewState: {
		zoomLevel: number;
		scrollLeft: number;
		playheadTime: MediaTime;
	}) => void;
}

export interface PlayheadConfigRef {
	readonly current: PlayheadConfig;
}

// --- Pure helpers (px → logical) ---

function pixelToTime({
	clientX,
	rulerEl,
	zoomLevel,
	duration,
}: {
	clientX: number;
	rulerEl: HTMLDivElement;
	zoomLevel: number;
	duration: MediaTime;
}): MediaTime {
	const rulerRect = rulerEl.getBoundingClientRect();
	const contentWidth = timelineTimeToPixels({ time: duration, zoomLevel });
	const clampedX = Math.max(
		0,
		Math.min(contentWidth, clientX - rulerRect.left),
	);
	const seconds = Math.max(
		0,
		Math.min(
			duration / TICKS_PER_SECOND,
			clampedX / (BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel),
		),
	);
	return mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
}

// --- Controller ---

export class PlayheadController {
	private lastMouseClientX = 0;
	private scrubFrame: number | null = null;
	private stopAutoScroll: (() => void) | undefined;

	private session: Session = { kind: "idle" };
	private readonly configRef: PlayheadConfigRef;

	constructor(deps: { configRef: PlayheadConfigRef }) {
		this.configRef = deps.configRef;
	}

	private get config(): PlayheadConfig {
		return this.configRef.current;
	}

	get isActive(): boolean {
		return this.session.kind !== "idle";
	}

	destroy(): void {
		if (this.session.kind === "scrubbing") this.endSession(this.session);
	}

	stopIfScopeChanged = (): void => {
		if (this.session.kind === "scrubbing" && !this.isCurrentScope(this.session)) {
			this.endSession(this.session);
		}
	};

	onPlayheadPointerDown = (event: ReactPointerEvent): void => {
		if (this.beginScrub(event, false)) event.stopPropagation();
	};

	onRulerPointerDown = (event: ReactPointerEvent): void => {
		if (this.config.getPlayheadEl()?.contains(event.target as Node)) return;
		this.beginScrub(event, true);
	};

	private beginScrub(event: ReactPointerEvent, didStartFromRuler: boolean): boolean {
		if (!event.isPrimary || event.button !== 0 || this.isActive) return false;
		event.preventDefault();
		const captureTarget = event.currentTarget;
		const session: ScrubSession = {
			kind: "scrubbing",
			didStartFromRuler,
			hasMoved: false,
			pointerId: event.pointerId,
			captureTarget,
			projectSession: this.config.getProjectSession(),
			sceneId: this.config.getSceneId(),
		};
		captureTarget.setPointerCapture(event.pointerId);
		this.session = session;
		this.activate(session);
		// Grabbing the playhead or the ruler stops playback, so the release leaves it paused where it was dropped.
		if (this.config.getIsPlaying()) this.config.pause();
		this.config.setScrubbing(true);
		// No element-edge snapping on initial ruler click — avoids a jarring jump.
		this.scrub({ clientX: event.clientX, isElementSnappingEnabled: !didStartFromRuler, forceSeek: true });
		return true;
	}

	// --- Public non-session methods ---

	/**
	 * Moves the playhead without changing its layout.
	 * Called on scroll and playback events to avoid React re-renders
	 * during animation frame updates.
	 */
	updatePlayheadPosition(time: MediaTime, scrollLeft?: number): void {
		const playheadEl = this.config.getPlayheadEl();
		if (!playheadEl) return;

		const resolvedScrollLeft = scrollLeft ?? this.config.getRulerScrollEl()?.scrollLeft ?? 0;
		const centerPixel = timelineTimeToSnappedPixels({
			time,
			zoomLevel: this.config.zoomLevel,
		});
		const offset = getCenteredLineLeft({ centerPixel }) - resolvedScrollLeft;
		const transform = `translateX(${offset}px)`;
		if (playheadEl.style.transform !== transform) playheadEl.style.transform = transform;
		const value = String(time);
		if (playheadEl.getAttribute("aria-valuenow") !== value) {
			playheadEl.setAttribute("aria-valuenow", value);
		}
	}

	handleScroll(time: MediaTime): void {
		this.updatePlayheadPosition(time);
		if (this.session.kind === "scrubbing" && this.session.hasMoved) {
			this.scheduleScrub();
		}
	}

	/**
	 * Updates the playhead position and auto-scrolls to keep the playhead
	 * visible during playback.
	 */
	handlePlaybackUpdate(time: MediaTime, isScrubbing: boolean): void {
		if (this.config.getIsPlaying() && !isScrubbing) {
			this.reveal(time);
		} else {
			this.updatePlayheadPosition(time);
		}
	}

	/** Scrolls the timeline to center a playhead that is out of view. */
	reveal(time: MediaTime): void {
		const rulerViewport = this.config.getRulerScrollEl();
		const tracksViewport = this.config.getTracksScrollEl();
		let scrollLeft = rulerViewport?.scrollLeft ?? 0;
		if (!rulerViewport || !tracksViewport) {
			this.updatePlayheadPosition(time, scrollLeft);
			return;
		}

		const playheadPixels = timelineTimeToPixels({
			time,
			zoomLevel: this.config.zoomLevel,
		});
		const viewportWidth = rulerViewport.clientWidth;
		const isOutOfView =
			playheadPixels < scrollLeft ||
			playheadPixels > scrollLeft + viewportWidth;

		if (isOutOfView) {
			const desiredScroll = Math.max(
				0,
				Math.min(
					rulerViewport.scrollWidth - viewportWidth,
					playheadPixels - viewportWidth / 2,
				),
			);
			rulerViewport.scrollLeft = tracksViewport.scrollLeft = desiredScroll;
			scrollLeft = rulerViewport.scrollLeft;
		}
		this.updatePlayheadPosition(time, scrollLeft);
	}

	// --- Private ---

	private activate(session: ScrubSession): void {
		window.addEventListener("pointermove", this.handlePointerMove, true);
		window.addEventListener("pointerup", this.handlePointerUp, true);
		window.addEventListener("pointercancel", this.handlePointerCancel, true);
		window.addEventListener("lostpointercapture", this.handlePointerCancel, true);
		window.addEventListener("blur", this.finishAtLastPosition);
		window.addEventListener("pagehide", this.finishAtLastPosition, true);
		document.addEventListener("visibilitychange", this.handleVisibilityChange, true);
		session.captureTarget.addEventListener("lostpointercapture", this.handlePointerCancel);
		this.stopAutoScroll = startEdgeAutoScroll({
			getMouseClientX: () => this.lastMouseClientX,
			getRulerViewport: () => this.config.getRulerScrollEl(),
			getTracksViewport: () => this.config.getTracksScrollEl(),
			getContentWidth: () => timelineTimeToPixels({
				time: this.config.getDuration(),
				zoomLevel: this.config.zoomLevel,
			}),
		});
	}

	private endSession(session: ScrubSession): void {
		this.session = { kind: "idle" };
		this.cancelScrubFrame();
		this.stopAutoScroll?.();
		this.stopAutoScroll = undefined;
		window.removeEventListener("pointermove", this.handlePointerMove, true);
		window.removeEventListener("pointerup", this.handlePointerUp, true);
		window.removeEventListener("pointercancel", this.handlePointerCancel, true);
		window.removeEventListener("lostpointercapture", this.handlePointerCancel, true);
		window.removeEventListener("blur", this.finishAtLastPosition);
		window.removeEventListener("pagehide", this.finishAtLastPosition, true);
		document.removeEventListener("visibilitychange", this.handleVisibilityChange, true);
		session.captureTarget.removeEventListener("lostpointercapture", this.handlePointerCancel);
		if (session.captureTarget.hasPointerCapture(session.pointerId)) {
			session.captureTarget.releasePointerCapture(session.pointerId);
		}
		this.config.setScrubbing(false);
	}

	private isCurrentScope(session: ScrubSession): boolean {
		return session.projectSession === this.config.getProjectSession() &&
			session.sceneId === this.config.getSceneId();
	}

	/**
	 * Converts pointer position to a frame-snapped timeline time and seeks.
	 * `isElementSnappingEnabled` controls element-edge snapping; frame-level snapping
	 * is always applied.
	 */
	private scrub({
		clientX,
		isElementSnappingEnabled,
		forceSeek = false,
	}: {
		clientX: number;
		isElementSnappingEnabled: boolean;
		forceSeek?: boolean;
	}): void {
		const session = this.session;
		if (session.kind !== "scrubbing") return;
		if (!this.isCurrentScope(session)) {
			this.endSession(session);
			return;
		}
		this.lastMouseClientX = clientX;
		const ruler = this.config.getRulerEl();
		if (!ruler) return;

		const fps = this.config.getActiveProjectFps();
		if (!fps) return;

		const { zoomLevel } = this.config;
		const duration = this.config.getDuration();
		const rawTime = pixelToTime({
			clientX,
			rulerEl: ruler,
			zoomLevel,
			duration,
		});
		const frameTime = snapSeekMediaTime({ time: rawTime, duration, fps });

		const time = (() => {
			if (!isElementSnappingEnabled || !this.config.isSnappingEnabled() || this.config.isShiftHeld())
				return frameTime;

			const tracks = this.config.getSceneTracks();
			const bookmarks = this.config.getSceneBookmarks();
			if (
				session.snapCache?.tracks !== tracks ||
				session.snapCache.bookmarks !== bookmarks
			) {
				session.snapCache = {
					tracks,
					bookmarks,
					index: buildSnapIndex({
						points: buildTimelineSnapPoints({
							sources: [
								() => getElementEdgeSnapPoints({ tracks }),
								() => getBookmarkSnapPoints({ bookmarks }),
								() => getAnimationKeyframeSnapPointsForTimeline({ tracks }),
							],
						}),
					}),
				};
			}
			const result = resolveIndexedSnap({
				targetTime: frameTime,
				index: session.snapCache.index,
				maxSnapDistance: getTimelineSnapThresholdInTicks({ zoomLevel }),
			});
			return result.snapPoint ? result.snappedTime : frameTime;
		})();

		this.updatePlayheadPosition(time);
		if (forceSeek || this.config.getCurrentTime() !== time) {
			this.config.seek(time);
		}
	}

	private scheduleScrub(): void {
		if (this.scrubFrame !== null) return;
		this.scrubFrame = requestAnimationFrame(() => {
			this.scrubFrame = null;
			this.scrub({
				clientX: this.lastMouseClientX,
				isElementSnappingEnabled: true,
			});
		});
	}

	private cancelScrubFrame(): void {
		if (this.scrubFrame === null) return;
		cancelAnimationFrame(this.scrubFrame);
		this.scrubFrame = null;
	}

	private handlePointerMove = (event: PointerEvent): void => {
		if (this.session.kind !== "scrubbing" || this.session.pointerId !== event.pointerId) return;
		this.lastMouseClientX = event.clientX;
		this.session.hasMoved = true;
		this.scheduleScrub();
	};

	private handlePointerUp = (event: PointerEvent): void => {
		if (this.session.kind !== "scrubbing" || this.session.pointerId !== event.pointerId) return;
		this.finishScrub(event.clientX);
	};

	private handlePointerCancel = (event: Event): void => {
		if (this.session.kind === "scrubbing" && this.session.pointerId === (event as PointerEvent).pointerId) {
			this.finishAtLastPosition();
		}
	};

	private handleVisibilityChange = (): void => {
		if (document.hidden) this.finishAtLastPosition();
	};

	private finishAtLastPosition = (): void => this.finishScrub();

	private finishScrub(releaseX?: number): void {
		const session = this.session;
		if (session.kind !== "scrubbing") return;
		if (this.isCurrentScope(session) &&
			(releaseX !== undefined || this.scrubFrame !== null)) {
			this.scrub({
				clientX: releaseX ?? this.lastMouseClientX,
				isElementSnappingEnabled: !session.didStartFromRuler || session.hasMoved,
			});
		}
		if (this.session !== session) return;
		this.endSession(session);
		if (!this.isCurrentScope(session)) return;

		const playheadTime = this.config.getCurrentTime();
		// Playback started again during the scrub (Space) resumes audio from the settled position.
		if (this.config.getIsPlaying()) {
			this.config.seek(playheadTime);
		}
		this.config.setTimelineViewState({
			zoomLevel: this.config.zoomLevel,
			scrollLeft: this.config.getTracksScrollEl()?.scrollLeft ?? 0,
			playheadTime,
		});
	}
}
