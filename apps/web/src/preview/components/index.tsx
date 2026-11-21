"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useDeepCompareEffect from "use-deep-compare-effect";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useContainerSize } from "@/hooks/use-container-size";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { TICKS_PER_SECOND } from "@/wasm";
import type { RootNode } from "@/services/renderer/nodes/root-node";
import { buildScene } from "@/services/renderer/scene-builder";
import { PreviewOverlayLayer } from "./overlay-layer";
import { PreviewInteractionOverlay } from "./preview-interaction-overlay";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import type {
	PreviewOverlayControl,
	PreviewOverlayInstance,
} from "@/preview/overlays";
import { PreviewContextMenu } from "./context-menu";
import { usePreviewStore } from "@/preview/preview-store";
import { previewQualityScale } from "@/preview/quality";
import { createPreviewFrameScheduler } from "@/preview/frame-scheduler";
import { PreviewToolbar } from "./toolbar";
import {
	PreviewViewportProvider,
	usePreviewViewportState,
} from "./preview-viewport";

function usePreviewSize() {
	const canvasSize = useEditor(
		(e) => e.project.getActive()?.settings.canvasSize,
	);

	return {
		width: canvasSize?.width,
		height: canvasSize?.height,
	};
}

function normalizeWheelDelta({
	delta,
	deltaMode,
	pageSize,
}: {
	delta: number;
	deltaMode: number;
	pageSize: number;
}): number {
	if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
		return delta * 16;
	}

	if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
		return delta * pageSize;
	}

	return delta;
}

export function PreviewPanel({
	fitRenderToViewport = false,
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	fitRenderToViewport?: boolean;
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	const { toggleFullscreen } = useFullscreen({ containerRef });
	const handleContainerRef = useCallback((node: HTMLDivElement | null) => {
		containerRef.current = node;
		setContainer(node);
	}, []);

	return (
		<div
			ref={handleContainerRef}
			className="panel bg-background relative flex size-full min-h-0 min-w-0 flex-col rounded-sm border"
		>
			<PreviewCanvas
				container={container}
				fitRenderToViewport={fitRenderToViewport}
				onToggleFullscreen={toggleFullscreen}
				overlayControls={overlayControls}
				overlayInstances={overlayInstances}
				onOverlayVisibilityChange={onOverlayVisibilityChange}
			/>
			<RenderTreeController />
		</div>
	);
}

function RenderTreeController() {
	const editor = useEditor();
	const tracks = useEditor(
		(e) => e.timeline.getPreviewTracks() ?? e.scenes.getActiveScene().tracks,
	);
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const scenes = useEditor((e) => e.scenes.getScenes());
	const activeProject = useEditor((e) => e.project.getActive());

	const { width, height } = usePreviewSize();

	useDeepCompareEffect(() => {
		if (!activeProject) return;

		const duration = editor.timeline.getTotalDuration();
		const renderTree = buildScene({
			tracks,
			mediaAssets,
			duration,
			canvasSize: { width, height },
			background: activeProject.settings.background,
			isPreview: true,
			scenes,
		});

		editor.renderer.setRenderTree({ renderTree });
	}, [tracks, mediaAssets, scenes, activeProject?.settings.background, width, height]);

	return null;
}

function PreviewCanvas({
	container,
	fitRenderToViewport,
	onToggleFullscreen,
	overlayControls,
	overlayInstances,
	onOverlayVisibilityChange,
}: {
	container: HTMLElement | null;
	fitRenderToViewport: boolean;
	onToggleFullscreen: () => void;
	overlayControls: PreviewOverlayControl[];
	overlayInstances: PreviewOverlayInstance[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const canvasMountRef = useRef<HTMLDivElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const lastFrameRef = useRef(-1);
	const lastSceneRef = useRef<RootNode | null>(null);
	const schedulerRef = useRef<ReturnType<typeof createPreviewFrameScheduler> | null>(null);
	const renderSignalRef = useRef<AbortSignal | null>(null);
	const lastRendererRef = useRef<CanvasRenderer | null>(null);
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const viewportSize = useContainerSize({ containerRef: viewportRef });
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const renderTree = useEditor((e) => e.renderer.getRenderTree());
	const viewport = usePreviewViewportState({
		canvasHeight: nativeHeight,
		canvasWidth: nativeWidth,
		viewportHeight: viewportSize.height,
		viewportRef,
		viewportWidth: viewportSize.width,
	});
	const { canPan, panByScreenDelta, scaleZoom } = viewport;

	const quality = usePreviewStore((state) => state.quality);
	const qualityScale = previewQualityScale(quality);
	const renderScale =
		fitRenderToViewport && viewportSize.width > 0 && viewportSize.height > 0
			? Math.min(qualityScale, (viewport.sceneWidth * window.devicePixelRatio) / nativeWidth)
			: qualityScale;
	const [settledScale, setSettledScale] = useState(renderScale);

	// Fit the displayed frame during the drag and resize the render target after it settles.
	useEffect(() => {
		if (!fitRenderToViewport || settledScale === renderScale) return;
		const timeout = window.setTimeout(() => setSettledScale(renderScale), 120);
		return () => window.clearTimeout(timeout);
	}, [fitRenderToViewport, renderScale, settledScale]);

	const outputScale = fitRenderToViewport ? Math.min(qualityScale, settledScale) : qualityScale;
	const sessionSignal = editor.project.getSessionSignal();
	const renderer = useMemo(() => {
		return new CanvasRenderer({
			width: nativeWidth,
			height: nativeHeight,
			fps: activeProject.settings.fps,
			renderScale: outputScale,
		});
	}, [nativeWidth, nativeHeight, activeProject.settings.fps, outputScale]);

	// Each renderer owns its output so snapshots and exports cannot resize the preview.
	useEffect(() => {
		const mount = canvasMountRef.current;
		if (!mount) return;
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, sessionSignal]);
		const clearVideo = () => renderer.videoCache.clear();
		signal.addEventListener("abort", clearVideo, { once: true });
		renderSignalRef.current = signal;
		lastFrameRef.current = -1;
		const outputCanvas = renderer.getOutputCanvas();
		outputCanvas.style.display = "block";
		outputCanvas.style.width = "100%";
		outputCanvas.style.height = "100%";
		if (!mount.firstChild) mount.appendChild(outputCanvas);
		return () => {
			renderSignalRef.current = null;
			controller.abort();
		};
	}, [renderer, sessionSignal]);

	const render = useCallback(() => {
		if (!renderTree) return;
		if (lastRendererRef.current !== renderer) {
			lastRendererRef.current = renderer;
			lastFrameRef.current = -1;
		}

		const renderTime = Math.min(
			editor.playback.getCurrentTime(),
			editor.timeline.getLastFrameTime(),
		);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * renderer.fps.denominator) / renderer.fps.numerator,
		);
		const frame = Math.floor(renderTime / ticksPerFrame);

		if (
			frame === lastFrameRef.current &&
			renderTree === lastSceneRef.current
		) {
			return;
		}

		const signal = renderSignalRef.current;
		if (!signal) return;
		const task = editor.renderer.renderPreview({ renderer, node: renderTree, time: renderTime, signal });
		if (!task) return;
		lastSceneRef.current = renderTree;
		lastFrameRef.current = frame;
		return task
			.then(() => {
				// Keep the previous frame visible while the new render target is waiting.
				const mount = canvasMountRef.current;
				const outputCanvas = renderer.getOutputCanvas();
				if (!signal.aborted && mount && outputCanvas.parentElement !== mount) {
					mount.replaceChildren(outputCanvas);
				}
			})
			.catch((error) => {
				if (!signal.aborted) console.error("Preview render failed:", error);
			});
	}, [renderer, renderTree, editor.playback, editor.renderer, editor.timeline]);

	const renderRef = useCommittedRef(render);
	useEffect(() => {
		const scheduler = createPreviewFrameScheduler({
			render: () => renderRef.current(),
			requestFrame: requestAnimationFrame,
			cancelFrame: cancelAnimationFrame,
		});
		schedulerRef.current = scheduler;
		const unsubscribe = [
			editor.playback.onUpdate(scheduler.playbackTick),
			editor.playback.onSeek(scheduler.request),
			editor.renderer.subscribe(scheduler.request),
		];
		return () => {
			schedulerRef.current = null;
			scheduler.dispose();
			for (const remove of unsubscribe) remove();
		};
	}, [editor, renderRef]);
	useEffect(() => {
		schedulerRef.current?.request();
	}, [render, sessionSignal]);

	useEffect(() => {
		const container = viewportRef.current;
		if (!container) return;

		let pendingZoomDelta = 0;
		let pendingPanDeltaX = 0;
		let pendingPanDeltaY = 0;
		let zoomRafId: ReturnType<typeof requestAnimationFrame> | null = null;
		let panRafId: ReturnType<typeof requestAnimationFrame> | null = null;

		const onWheel = (event: WheelEvent) => {
			const normalizedDeltaX = normalizeWheelDelta({
				delta: event.deltaX,
				deltaMode: event.deltaMode,
				pageSize: container.clientWidth,
			});
			const normalizedDeltaY = normalizeWheelDelta({
				delta: event.deltaY,
				deltaMode: event.deltaMode,
				pageSize: container.clientHeight,
			});
			const isZoomGesture = event.ctrlKey || event.metaKey;
			if (isZoomGesture) {
				event.preventDefault();
				pendingZoomDelta += normalizedDeltaY;

				if (zoomRafId === null) {
					zoomRafId = requestAnimationFrame(() => {
						const cappedDelta =
							Math.sign(pendingZoomDelta) *
							Math.min(Math.abs(pendingZoomDelta), 30);
						const zoomFactor = Math.exp(-cappedDelta / 300);

						scaleZoom({ factor: zoomFactor });
						pendingZoomDelta = 0;
						zoomRafId = null;
					});
				}

				return;
			}

			if (!canPan) {
				return;
			}

			if (normalizedDeltaX === 0 && normalizedDeltaY === 0) {
				return;
			}

			event.preventDefault();
			pendingPanDeltaX += normalizedDeltaX;
			pendingPanDeltaY += normalizedDeltaY;

			if (panRafId === null) {
				panRafId = requestAnimationFrame(() => {
					panByScreenDelta({
						deltaX: pendingPanDeltaX,
						deltaY: pendingPanDeltaY,
					});
					pendingPanDeltaX = 0;
					pendingPanDeltaY = 0;
					panRafId = null;
				});
			}
		};

		container.addEventListener("wheel", onWheel, {
			capture: true,
			passive: false,
		});

		return () => {
			container.removeEventListener("wheel", onWheel, {
				capture: true,
			});
			if (zoomRafId !== null) {
				cancelAnimationFrame(zoomRafId);
			}
			if (panRafId !== null) {
				cancelAnimationFrame(panRafId);
			}
		};
	}, [canPan, panByScreenDelta, scaleZoom]);

	return (
		<PreviewViewportProvider value={viewport}>
			<div className="flex size-full min-h-0 min-w-0 flex-col">
				<div className="flex min-h-0 min-w-0 flex-1 p-2 pb-0">
					<ContextMenu>
						<ContextMenuTrigger asChild>
							<div
								ref={viewportRef}
								className="relative flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden"
							>
							<div
								ref={canvasMountRef}
								className="absolute block border"
								style={{
									left: viewport.sceneLeft,
									top: viewport.sceneTop,
									width: viewport.sceneWidth,
									height: viewport.sceneHeight,
									background:
										activeProject.settings.background.type === "blur"
											? "transparent"
											: activeProject?.settings.background.color,
								}}
							/>
								<PreviewOverlayLayer
									instances={overlayInstances}
									plane="under-interaction"
								/>
								<PreviewInteractionOverlay />
								<PreviewOverlayLayer
									instances={overlayInstances}
									plane="over-interaction"
								/>
							</div>
						</ContextMenuTrigger>
						<PreviewContextMenu
							onToggleFullscreen={onToggleFullscreen}
							container={container}
							overlayControls={overlayControls}
							onOverlayVisibilityChange={onOverlayVisibilityChange}
						/>
					</ContextMenu>
				</div>
				<PreviewToolbar
					compact={fitRenderToViewport}
					onToggleFullscreen={onToggleFullscreen}
				/>
			</div>
		</PreviewViewportProvider>
	);
}
