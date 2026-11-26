"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useDeepCompareEffect from "use-deep-compare-effect";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { useContainerSize } from "@/hooks/use-container-size";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { preparePreviewOriginals, visibleVideoNodes } from "@/services/renderer/resolve";
import { subscribeFontLoads } from "@/fonts/google-fonts";
import { useProxySession, useProxyStore } from "@/services/proxies/client";
import { VideoCache } from "@/services/video-cache/service";
import { previewCanvasSize } from "@/canvas/sizes";
import { GraphicsDeviceError } from "@/services/renderer/device-lifecycle";
import { RecoverableSurfaceError, rendererDevice } from "@/services/renderer/renderer-device";
import { modelGraphics } from "@/model3d/render";
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
import { createScrubSettle } from "@/preview/scrub-settle";
import { PreviewToolbar } from "./toolbar";
import { BookmarkAreaLayer } from "./bookmark-area";
import { useBookmarkArea } from "@/timeline/bookmarks/area-state";
import {
	PreviewViewportProvider,
	PreviewFramingProvider,
	usePreviewViewportState,
} from "./preview-viewport";

function usePreviewSize() {
	const canvasSize = useEditor(
		(e) => e.project.getActive()?.settings.canvasSize,
	);

	return previewCanvasSize(canvasSize);
}

export function EditorPreviewFraming({ children }: { children: React.ReactNode }) {
	const { width, height } = usePreviewSize();
	return <PreviewFramingProvider canvasWidth={width} canvasHeight={height}>{children}</PreviewFramingProvider>;
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
	const [areaFormHost, setAreaFormHost] = useState<HTMLDivElement | null>(null);
	const areaEditing = useBookmarkArea((state) => state.editing !== null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const lastFrameRef = useRef(-1);
	const lastWasProxy = useRef(false);
	const lastSceneRef = useRef<RootNode | null>(null);
	const schedulerRef = useRef<ReturnType<typeof createPreviewFrameScheduler> | null>(null);
	const renderSignalRef = useRef<AbortSignal | null>(null);
	const lastRendererRef = useRef<CanvasRenderer | null>(null);
	// A frame that failed to draw is shown as such (with Retry) until a frame draws again.
	const [renderFailed, setRenderFailed] = useState(false);
	const renderFailedRef = useRef(false);
	const markRenderFailed = useCallback((failed: boolean) => {
		if (renderFailedRef.current === failed) return;
		renderFailedRef.current = failed;
		setRenderFailed(failed);
	}, []);
	const { t } = useI18n();
	const { width: nativeWidth, height: nativeHeight } = usePreviewSize();
	const viewportSize = useContainerSize({ containerRef: viewportRef });
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	useProxySession(editor, activeProject.metadata.id);
	const renderTree = useEditor((e) => e.renderer.getRenderTree());
	const getRenderTime = useCallback(() => Math.min(
		editor.playback.getCurrentTime(),
		editor.timeline.getLastFrameTime(),
	), [editor]);
	const settle = useMemo(() => createScrubSettle<RootNode, VideoCache>({
		async prepare(scene, time, decodeSignal) {
			const signal = renderSignalRef.current;
			const ready = useProxyStore.getState().ready;
			if (!signal || signal.aborted || rendererDevice.status.state !== "ready" ||
				editor.renderer.isExportRunning() || !ready.size) return null;
			const cache = new VideoCache();
			const scope = AbortSignal.any([signal, rendererDevice.signal, decodeSignal]);
			const clear = () => cache.clear();
			scope.addEventListener("abort", clear, { once: true });
			try {
				if (await preparePreviewOriginals(scene, time, cache, scope, ready)) return cache;
				clear();
				return null;
			} catch (error) {
				clear();
				throw error;
			} finally {
				scope.removeEventListener("abort", clear);
			}
		},
		onResult: () => schedulerRef.current?.request(),
		discard: cache => cache.clear(),
	}), [editor]);
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
		const clearVideo = () => { renderer.videoCache.clear(); settle.reset(); };
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
	}, [renderer, sessionSignal, settle]);

	const render = useCallback(() => {
		if (!renderTree || rendererDevice.status.state !== "ready") return;
		if (lastRendererRef.current !== renderer) {
			lastRendererRef.current = renderer;
			lastFrameRef.current = -1;
		}

		const renderTime = getRenderTime();
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * renderer.fps.denominator) / renderer.fps.numerator,
		);
		const frame = Math.floor(renderTime / ticksPerFrame);
		const ready = useProxyStore.getState().ready;
		const playing = editor.playback.getIsPlaying();
		const scrubbing = editor.playback.getIsScrubbing() && !playing;
		const settled = !playing && settle.isPrepared(renderTree, renderTime);
		const proxy = ready.size > 0 && scrubbing && !settled;
		if (!scrubbing && !playing && settle.isPending(renderTree, renderTime)) return;

		if (
			frame === lastFrameRef.current &&
			proxy === lastWasProxy.current &&
			renderTree === lastSceneRef.current
		) {
			// This frame rendered before and is the one on screen, so a failure of another frame no longer applies.
			markRenderFailed(false);
			return;
		}

		const signal = renderSignalRef.current;
		if (!signal) return;
		const graphics = rendererDevice.signal;
		if (editor.renderer.isExportRunning()) return;
		const originals = settled ? settle.take(renderTree, renderTime) : undefined;
		const visible = proxy ? visibleVideoNodes(renderTree, renderTime) : undefined;
		const task = visible ? renderer.render({ node: renderTree, time: renderTime, signal, preview: {
			proxies: ready,
			onProxyUnavailable: key => useProxyStore.getState().invalidate(key),
			valid() {
				if (!editor.playback.getIsScrubbing() || editor.playback.getIsPlaying() ||
					editor.renderer.getRenderTree() !== renderTree || useProxyStore.getState().settings.enabled === false) return false;
				const now = getRenderTime();
				if (now === renderTime) return true;
				const current = visibleVideoNodes(renderTree, now);
				return current.size === visible.size && [...current].every(node => visible.has(node));
			},
		} }) : settled ? renderer.render({ node: renderTree, time: renderTime, signal, preview: {
			originals,
			valid: () => !editor.playback.getIsPlaying() && !editor.renderer.isExportRunning() &&
				editor.renderer.getRenderTree() === renderTree && getRenderTime() === renderTime,
		} }) : editor.renderer.renderPreview({ renderer, node: renderTree, time: renderTime, signal });
		if (!task) return;
		return task
			.then(() => {
				// Keep the previous frame visible while the new render target is waiting.
				const mount = canvasMountRef.current;
				if (signal.aborted || graphics.aborted || !mount) return;
				const outputCanvas = renderer.getOutputCanvas();
				if (outputCanvas.parentElement !== mount) mount.replaceChildren(outputCanvas);
				lastSceneRef.current = renderTree;
				lastFrameRef.current = frame;
				lastWasProxy.current = proxy;
				markRenderFailed(false);
			})
			.catch((error) => {
				if (!signal.aborted && !graphics.aborted && error instanceof RecoverableSurfaceError) throw error;
				if (!signal.aborted && !(error instanceof GraphicsDeviceError) && !(error instanceof DOMException && error.name === "AbortError")) {
					console.error("Preview render failed:", error);
					markRenderFailed(true);
				}
			});
	}, [renderer, renderTree, editor.playback, editor.renderer, getRenderTime, settle, markRenderFailed]);

	const renderRef = useCommittedRef(render);
	useEffect(() => {
		const scheduler = createPreviewFrameScheduler({
			render: () => renderRef.current(),
			requestFrame: requestAnimationFrame,
			cancelFrame: cancelAnimationFrame,
			shouldRetry: (error) => error instanceof RecoverableSurfaceError,
		});
		schedulerRef.current = scheduler;
		const redraw = () => {
			lastFrameRef.current = -1;
			scheduler.request();
		};
		const updateTarget = () => {
			const scene = editor.renderer.getRenderTree();
			if (!scene) settle.reset();
			else settle.update(scene, getRenderTime(), !document.hidden &&
				editor.playback.getIsScrubbing() &&
				!editor.renderer.isExportRunning() && useProxyStore.getState().ready.size > 0, editor.playback.getIsPlaying());
			scheduler.request();
		};
		const onVisibility = () => {
			if (document.hidden) settle.reset();
			else { updateTarget(); redraw(); }
		};
		document.addEventListener("visibilitychange", onVisibility);
		const unsubscribe = [
			editor.playback.subscribeState(updateTarget),
			editor.playback.onUpdate(scheduler.playbackTick),
			editor.playback.onSeek(updateTarget),
			editor.renderer.subscribe(updateTarget),
			useProxyStore.subscribe((state, previous) => { if (state.ready !== previous.ready) updateTarget(); }),
			rendererDevice.subscribe(() => {
				if (rendererDevice.status.state === "ready") { updateTarget(); redraw(); }
				else settle.reset();
			}),
			modelGraphics.subscribe(() => { if (!modelGraphics.getSnapshot()) redraw(); }),
			// Text drawn with a fallback font while its font loaded is drawn again.
			subscribeFontLoads(redraw),
		];
		updateTarget();
		return () => {
			schedulerRef.current = null;
			settle.reset();
			scheduler.dispose();
			document.removeEventListener("visibilitychange", onVisibility);
			for (const remove of unsubscribe) remove();
		};
	}, [editor, getRenderTime, renderRef, settle]);
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
								onPointerMove={(event) => viewport.handlePanPointerMove({ event })}
								onPointerUp={(event) => viewport.handlePanPointerUp({ event })}
								onPointerCancel={(event) => viewport.handlePanPointerUp({ event })}
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
								<BookmarkAreaLayer formHost={areaFormHost} />
								{renderFailed && (
									<div role="alert" className="bg-background/90 absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md border px-3 py-1.5 text-xs shadow">
										<span>{t("preview.renderFailed")}</span>
										<Button
											size="sm"
											variant="outline"
											onClick={() => {
												lastFrameRef.current = -1;
												schedulerRef.current?.request();
											}}
										>
											{t("common.retry")}
										</Button>
									</div>
								)}
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
				<div ref={setAreaFormHost} className={areaEditing ? "min-h-14 shrink-0 px-2 pt-1" : undefined} />
				<PreviewToolbar
					compact={fitRenderToViewport}
					onToggleFullscreen={onToggleFullscreen}
				/>
			</div>
		</PreviewViewportProvider>
	);
}
