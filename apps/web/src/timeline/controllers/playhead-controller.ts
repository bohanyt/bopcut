import type { MouseEvent as ReactMouseEvent } from "react";
import type { FrameRate } from "opencut-wasm";
import {
	mediaTime,
	snapSeekMediaTime,
	TICKS_PER_SECOND,
	type MediaTime,
} from "@/wasm";
import {
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
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
	/** True once the mouse has moved during a ruler drag. */
	hasMoved: boolean;
	/** Most recent frame-snapped time set by scrub(). */
	currentTime: MediaTime | null;
	snapCache?: {
		tracks: SceneTracks;
		bookmarks: Bookmark[];
		points: SnapPoint[];
	};
}

type Session = { kind: "idle" } | ScrubSession;

// --- Config ---

export interface PlayheadConfig {
	zoomLevel: number;
	duration: MediaTime;
	getActiveProjectFps: () => FrameRate | null;
	isShiftHeld: () => boolean;
	getIsPlaying: () => boolean;
	getRulerEl: () => HTMLDivElement | null;
	getRulerScrollEl: () => HTMLDivElement | null;
	getTracksScrollEl: () => HTMLDivElement | null;
	getPlayheadEl: () => HTMLDivElement | null;
	getSceneTracks: () => SceneTracks;
	getSceneBookmarks: () => Bookmark[];
	seek: (time: MediaTime) => void;
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
		this.onPlayheadMouseDown = this.onPlayheadMouseDown.bind(this);
		this.onRulerMouseDown = this.onRulerMouseDown.bind(this);
		this.handleMouseMove = this.handleMouseMove.bind(this);
		this.handleMouseUp = this.handleMouseUp.bind(this);
	}

	private get config(): PlayheadConfig {
		return this.configRef.current;
	}

	get isActive(): boolean {
		return this.session.kind !== "idle";
	}

	destroy(): void {
		if (this.isActive) {
			this.session = { kind: "idle" };
			this.config.setScrubbing(false);
		}
		this.deactivate();
	}

	// --- Public event handlers (bound, stable references) ---

	onPlayheadMouseDown(event: ReactMouseEvent): void {
		event.preventDefault();
		event.stopPropagation();
		this.session = {
			kind: "scrubbing",
			didStartFromRuler: false,
			hasMoved: false,
			currentTime: null,
		};
		this.config.setScrubbing(true);
		this.scrub({ clientX: event.clientX, isElementSnappingEnabled: true });
		this.activate();
	}

	onRulerMouseDown(event: ReactMouseEvent): void {
		if (event.button !== 0) return;
		if (this.config.getPlayheadEl()?.contains(event.target as Node)) return;

		event.preventDefault();
		this.session = {
			kind: "scrubbing",
			didStartFromRuler: true,
			hasMoved: false,
			currentTime: null,
		};
		this.config.setScrubbing(true);
		// No element-edge snapping on initial ruler click — avoids a jarring jump.
		this.scrub({ clientX: event.clientX, isElementSnappingEnabled: false });
		this.activate();
	}

	// --- Public non-session methods ---

	/**
	 * Imperatively updates the playhead DOM element's `left` style.
	 * Called on scroll and playback events to avoid React re-renders
	 * during animation frame updates.
	 */
	updatePlayheadLeft(time: MediaTime): void {
		const playheadEl = this.config.getPlayheadEl();
		if (!playheadEl) return;

		const centerPixel = timelineTimeToSnappedPixels({
			time,
			zoomLevel: this.config.zoomLevel,
		});
		const scrollLeft = this.config.getRulerScrollEl()?.scrollLeft ?? 0;
		const left = `${getCenteredLineLeft({ centerPixel }) - scrollLeft}px`;
		if (playheadEl.style.left !== left) playheadEl.style.left = left;
		const value = String(time);
		if (playheadEl.getAttribute("aria-valuenow") !== value) {
			playheadEl.setAttribute("aria-valuenow", value);
		}
	}

	handleScroll(time: MediaTime): void {
		if (this.session.kind === "scrubbing") {
			this.updatePlayheadLeft(this.session.currentTime ?? time);
			if (this.session.hasMoved) this.scheduleScrub();
		} else {
			this.updatePlayheadLeft(time);
		}
	}

	/**
	 * Updates the playhead position and auto-scrolls to keep the playhead
	 * visible during playback.
	 */
	handlePlaybackUpdate(time: MediaTime): void {
		this.updatePlayheadLeft(time);

		// Auto-scroll only during playback, not while scrubbing.
		if (!this.config.getIsPlaying() || this.session.kind === "scrubbing")
			return;

		const rulerViewport = this.config.getRulerScrollEl();
		const tracksViewport = this.config.getTracksScrollEl();
		if (!rulerViewport || !tracksViewport) return;

		const playheadPixels = timelineTimeToPixels({
			time,
			zoomLevel: this.config.zoomLevel,
		});
		const viewportWidth = rulerViewport.clientWidth;
		const isOutOfView =
			playheadPixels < rulerViewport.scrollLeft ||
			playheadPixels > rulerViewport.scrollLeft + viewportWidth;

		if (isOutOfView) {
			const desiredScroll = Math.max(
				0,
				Math.min(
					rulerViewport.scrollWidth - viewportWidth,
					playheadPixels - viewportWidth / 2,
				),
			);
			rulerViewport.scrollLeft = tracksViewport.scrollLeft = desiredScroll;
		}
	}

	// --- Private ---

	private activate(): void {
		window.addEventListener("mousemove", this.handleMouseMove);
		window.addEventListener("mouseup", this.handleMouseUp);
		this.stopAutoScroll?.();
		this.stopAutoScroll = startEdgeAutoScroll({
			getMouseClientX: () => this.lastMouseClientX,
			getRulerViewport: () => this.config.getRulerScrollEl(),
			getTracksViewport: () => this.config.getTracksScrollEl(),
			getContentWidth: () => timelineTimeToPixels({
				time: this.config.duration,
				zoomLevel: this.config.zoomLevel,
			}),
		});
	}

	private deactivate(): void {
		this.cancelScrubFrame();
		this.stopAutoScroll?.();
		this.stopAutoScroll = undefined;
		window.removeEventListener("mousemove", this.handleMouseMove);
		window.removeEventListener("mouseup", this.handleMouseUp);
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
		this.lastMouseClientX = clientX;
		const ruler = this.config.getRulerEl();
		if (!ruler) return;

		const fps = this.config.getActiveProjectFps();
		if (!fps) return;

		const { zoomLevel, duration } = this.config;
		const rawTime = pixelToTime({
			clientX,
			rulerEl: ruler,
			zoomLevel,
			duration,
		});
		const frameTime = snapSeekMediaTime({ time: rawTime, duration, fps });

		const time = (() => {
			if (!isElementSnappingEnabled || this.config.isShiftHeld())
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
					points: buildTimelineSnapPoints({
						sources: [
							() => getElementEdgeSnapPoints({ tracks }),
							() => getBookmarkSnapPoints({ bookmarks }),
							() => getAnimationKeyframeSnapPointsForTimeline({ tracks }),
						],
					}),
				};
			}
			const result = resolveTimelineSnap({
				targetTime: frameTime,
				snapPoints: session.snapCache.points,
				maxSnapDistance: getTimelineSnapThresholdInTicks({ zoomLevel }),
			});
			return result.snapPoint ? result.snappedTime : frameTime;
		})();

		this.updatePlayheadLeft(time);
		// Playback time may advance between moves even when the pointer snaps to the same frame.
		if (forceSeek || session.currentTime !== time || this.config.getIsPlaying()) {
			session.currentTime = time;
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

	private handleMouseMove(event: MouseEvent): void {
		if (this.session.kind !== "scrubbing") return;
		this.lastMouseClientX = event.clientX;
		this.session.hasMoved = true;
		this.scheduleScrub();
	}

	private handleMouseUp(event: MouseEvent): void {
		if (this.session.kind !== "scrubbing") return;

		const session = this.session;
		this.cancelScrubFrame();
		this.config.setScrubbing(false);
		// Flush the release position before saving. The final seek also resumes audio
		// if the controller was scrubbing while playback was running.
		this.scrub({
			clientX: event.clientX,
			isElementSnappingEnabled: !session.didStartFromRuler || session.hasMoved,
			forceSeek: true,
		});

		if (session.currentTime !== null) {
			this.config.setTimelineViewState({
				zoomLevel: this.config.zoomLevel,
				scrollLeft: this.config.getTracksScrollEl()?.scrollLeft ?? 0,
				playheadTime: session.currentTime,
			});
		}

		this.session = { kind: "idle" };
		this.deactivate();
	}
}
