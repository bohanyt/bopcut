import { useEffect, useLayoutEffect, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useTimelineStore } from "@/timeline/timeline-store";
import { isTimelineGestureActive } from "@/timeline/gesture-state";
import {
	PlayheadController,
	type PlayheadConfig,
} from "@/timeline/controllers/playhead-controller";

interface UseTimelinePlayheadProps {
	zoomLevel: number;
	rulerRef: React.RefObject<HTMLDivElement | null>;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	playheadRef: React.RefObject<HTMLDivElement | null>;
}

export function useTimelinePlayhead({
	zoomLevel,
	rulerRef,
	rulerScrollRef,
	tracksScrollRef,
	playheadRef,
}: UseTimelinePlayheadProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const config: PlayheadConfig = {
		zoomLevel,
		getDuration: () => editor.timeline.getTotalDuration(),
		getProjectSession: () => editor.project.getSession(),
		getSceneId: () => editor.scenes.getActiveSceneOrNull()?.id,
		getCurrentTime: () => editor.playback.getCurrentTime(),
		getActiveProjectFps: () => editor.project.getActive()?.settings.fps ?? null,
		isShiftHeld: () => isShiftHeldRef.current,
		isSnappingEnabled: () => useTimelineStore.getState().snappingEnabled,
		getIsPlaying: () => editor.playback.getIsPlaying(),
		getRulerEl: () => rulerRef.current,
		getRulerScrollEl: () => rulerScrollRef.current,
		getTracksScrollEl: () => tracksScrollRef.current,
		getPlayheadEl: () => playheadRef.current,
		getSceneTracks: () => editor.scenes.getActiveScene().tracks,
		getSceneBookmarks: () => editor.scenes.getActiveScene()?.bookmarks ?? [],
		seek: (time) => editor.playback.seek({ time }),
		pause: () => editor.playback.pause(),
		setScrubbing: (scrubbing) =>
			editor.playback.setScrubbing({ isScrubbing: scrubbing }),
		setTimelineViewState: ({ zoomLevel, scrollLeft, playheadTime }) =>
			editor.project.setTimelineViewState({
				viewState: {
					zoomLevel,
					scrollLeft,
					playheadTime,
				},
			}),
	};
	const configRef = useCommittedRef(config);
	const [ctrl] = useState(() => new PlayheadController({ configRef }));

	useLayoutEffect(() => {
		ctrl.updatePlayheadPosition(editor.playback.getCurrentTime());
	}, [ctrl, editor.playback, zoomLevel]);

	// Scroll → keep playhead position in sync with scroll offset.
	useEffect(() => {
		const scrollEl = rulerScrollRef.current;
		if (!scrollEl) return;
		const handler = () => {
			if (!editor.playback.getIsScrubbing() || ctrl.isActive) {
				ctrl.handleScroll(editor.playback.getCurrentTime());
			}
		};
		scrollEl.addEventListener("scroll", handler, { passive: true });
		return () => scrollEl.removeEventListener("scroll", handler);
	}, [ctrl, editor.playback, rulerScrollRef]);

	// Playback events → update playhead position and auto-scroll during playback.
	useEffect(() => {
		ctrl.updatePlayheadPosition(editor.playback.getCurrentTime());
		const unsubscribeUpdate = editor.playback.onUpdate((time) =>
			ctrl.handlePlaybackUpdate(time, editor.playback.getIsScrubbing()),
		);
		const unsubscribeSeek = editor.playback.onSeek((time) =>
			ctrl.handlePlaybackUpdate(time, editor.playback.getIsScrubbing()),
		);
		let revealFrame = 0;
		// A new clip can extend the timeline, so wait for its layout.
		const unsubscribeReveal = editor.playback.onReveal(() => {
			cancelAnimationFrame(revealFrame);
			revealFrame = requestAnimationFrame(() => {
				// Scrolling under a held clip or edge would move its drop position.
				if (editor.playback.getIsScrubbing() || isTimelineGestureActive() || editor.timeline.isPreviewActive()) return;
				ctrl.reveal(editor.playback.getCurrentTime());
			});
		});
		return () => {
			unsubscribeUpdate();
			unsubscribeSeek();
			unsubscribeReveal();
			cancelAnimationFrame(revealFrame);
		};
	}, [ctrl, editor.playback, editor.timeline]);

	useEffect(() => {
		const stopScene = editor.scenes.subscribe(ctrl.stopIfScopeChanged);
		const stopProject = editor.project.subscribe(ctrl.stopIfScopeChanged);
		return () => {
			stopScene();
			stopProject();
			ctrl.destroy();
		};
	}, [ctrl, editor]);

	return {
		handlePlayheadPointerDown: ctrl.onPlayheadPointerDown,
		handleRulerPointerDown: ctrl.onRulerPointerDown,
	};
}
