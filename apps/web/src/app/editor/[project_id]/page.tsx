"use client";

import { localizeErrorDetail } from "@/i18n/error-details";

import { useI18n } from "@/i18n/provider";
import { useParams } from "next/navigation";
import {
	ResizablePanelGroup,
	ResizablePanel,
	ResizableHandle,
} from "@/components/ui/resizable";
import { AssetsPanel } from "@/components/editor/panels/assets";
import { PropertiesPanel } from "@/components/editor/panels/properties";
import { Timeline } from "@/timeline/components";
import { EditorPreviewFraming, PreviewPanel } from "@/preview/components";
import { EditorHeader } from "@/components/editor/editor-header";
import { EditorProvider } from "@/components/providers/editor-provider";
import { Onboarding } from "@/components/editor/onboarding";
import { MigrationDialog } from "@/project/components/migration-dialog";
import { usePanelStore } from "@/editor/panel-store";
import { usePasteMedia } from "@/media/use-paste-media";
import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { installAgentBridge } from "@/agent/bridge";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { rendererDevice } from "@/services/renderer/renderer-device";
import { modelGraphics, retryModelGraphics } from "@/model3d/render";
import { ChangelogNotification } from "@/changelog/components/changelog-notification";
import {
	createPreviewOverlayControl,
	isPreviewOverlayVisible,
	mergePreviewOverlaySources,
} from "@/preview/overlays";
import { usePreviewStore } from "@/preview/preview-store";
import { getGuidePreviewOverlaySource } from "@/guides";
import {
	bookmarkNotesPreviewOverlay,
	getBookmarkPreviewOverlaySource,
} from "@/timeline/bookmarks/index";

export default function Editor() {
	const params = useParams();
	const projectId = params.project_id as string;
	useEffect(() => installAgentBridge(), []);

	return (
			<EditorProvider projectId={projectId}>
				<div className="bg-background flex h-screen w-screen flex-col overflow-hidden">
					<GraphicsStatusBanner />
					<ModelGraphicsStatusBanner />
					<EditorHeader />
					<div className="min-h-0 min-w-0 flex-1">
						<EditorPreviewFraming>
							<EditorLayout />
						</EditorPreviewFraming>
					</div>
					<Onboarding />
					<MigrationDialog />
					<ChangelogNotification />
				</div>
			</EditorProvider>
	);
}

function GraphicsStatusBanner() {
	const { t } = useI18n();
	const status = useSyncExternalStore(rendererDevice.subscribe, rendererDevice.getSnapshot, rendererDevice.getSnapshot);
	if (status.state === "ready") return null;

	return (
		<div role="status" className="bg-accent border-b flex flex-wrap items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground">
			{status.state === "unavailable" ? (
				<>
					<span title={status.detail && localizeErrorDetail(status.detail, t)}>{t("editor.graphicsUnavailable")}</span>
					<Button variant="outline" size="sm" onClick={() => void rendererDevice.retry()}>
						{t("editor.retryGraphics")}
					</Button>
				</>
			) : (
				<span>{t(status.state === "recovering" ? "editor.recoveringGraphics" : "editor.startingGraphics")}</span>
			)}
		</div>
	);
}

function ModelGraphicsStatusBanner() {
	const { t } = useI18n();
	const unavailable = useSyncExternalStore(modelGraphics.subscribe, modelGraphics.getSnapshot, () => false);
	if (!unavailable) return null;
	return (
		<div role="status" className="bg-accent border-b flex flex-wrap items-center justify-center gap-2 px-3 py-2 text-xs text-muted-foreground">
			<span>{t("editor.modelGraphicsUnavailable")}</span>
			<Button variant="outline" size="sm" onClick={retryModelGraphics}>{t("editor.retryModelGraphics")}</Button>
		</div>
	);
}

function EditorLayout() {
	const { t } = useI18n();
	usePasteMedia();
	const editor = useEditor();
	const isPreviewRight = usePanelStore((state) => state.layout === "preview-right");
	const activeGuide = usePreviewStore((state) => state.activeGuide);
	const overlays = usePreviewStore((state) => state.overlays);
	const setOverlayVisibility = usePreviewStore(
		(state) => state.setOverlayVisibility,
	);

	useLayoutEffect(() => {
		// Restore the saved position on editor entry, even if the timeline remounts later.
		const { playheadTime } = editor.project.getTimelineViewState();
		if (playheadTime !== undefined) editor.playback.seek({ time: playheadTime });
		const session = editor.project.getSession();
		const savePlayhead = () => {
			if (editor.project.getSession() === session) editor.project.savePendingPlayhead();
		};
		const onVisibilityChange = () => {
			if (document.hidden) savePlayhead();
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			document.removeEventListener("visibilitychange", onVisibilityChange);
			savePlayhead();
		};
	}, [editor]);

	const showBookmarkNotes = isPreviewOverlayVisible({
		overlay: bookmarkNotesPreviewOverlay,
		overlays,
	});

	const overlaySource = useMemo(
		() =>
			mergePreviewOverlaySources({
				sources: [
					getGuidePreviewOverlaySource({
						guideId: activeGuide,
					}),
					getBookmarkPreviewOverlaySource({ isVisible: showBookmarkNotes }),
				],
			}),
		[activeGuide, showBookmarkNotes],
	);

	const overlayControls = useMemo(
		() =>
			overlaySource.definitions.map((overlay) =>
				createPreviewOverlayControl({ overlay, overlays }),
			),
		[overlaySource.definitions, overlays],
	);

	const preview = (
		<PreviewPanel
			fitRenderToViewport={isPreviewRight}
			overlayControls={overlayControls}
			overlayInstances={overlaySource.instances}
			onOverlayVisibilityChange={setOverlayVisibility}
		/>
	);

	if (!isPreviewRight) return <EditorWorkArea centerPreview={preview} />;

	const { rightPanels, setRightPanel } = usePanelStore.getState();
	return (
		<ResizablePanelGroup
			direction="horizontal"
			className="gap-[0.19rem] px-3 pb-3"
			onLayout={([, previewWidth]) =>
				setRightPanel({ panel: "preview", size: previewWidth })
			}
		>
			<ResizablePanel defaultSize={100 - rightPanels.preview} minSize={55}>
				<EditorWorkArea />
			</ResizablePanel>
			<ResizableHandle
				aria-label={t("editor.resizePreview")}
				className="bg-border hover:bg-accent-foreground/40"
			/>
			<ResizablePanel defaultSize={rightPanels.preview} minSize={24} maxSize={45}>
				{preview}
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}

function EditorWorkArea({ centerPreview }: { centerPreview?: ReactNode }) {
	const { panels, rightPanels, setPanels, setRightPanel } = usePanelStore.getState();
	const isClassic = centerPreview != null;
	const timelineSize = isClassic ? panels.timeline : rightPanels.timeline;

	return (
		<ResizablePanelGroup
			direction="vertical"
			className="size-full gap-[0.18rem]"
			onLayout={([mainContent, timeline]) => {
				if (isClassic) {
					setPanels({ mainContent, timeline });
				} else {
					setRightPanel({ panel: "timeline", size: timeline });
				}
			}}
		>
			<ResizablePanel
				defaultSize={isClassic ? panels.mainContent : 100 - timelineSize}
				minSize={30}
				maxSize={isClassic ? 85 : 75}
				className="min-h-0"
			>
				<ResizablePanelGroup
					direction="horizontal"
					className={isClassic ? "gap-[0.19rem] px-3" : "gap-[0.19rem]"}
					onLayout={([tools, second, third]) => {
						if (isClassic) {
							setPanels({ tools, preview: second, properties: third });
						} else {
							setRightPanel({ panel: "tools", size: tools });
						}
					}}
				>
					<ResizablePanel
						defaultSize={isClassic ? panels.tools : rightPanels.tools}
						minSize={isClassic ? 15 : 30}
						maxSize={isClassic ? 40 : 70}
						className="min-w-0"
					>
						<AssetsPanel />
					</ResizablePanel>

					<ResizableHandle withHandle />

					{isClassic && (
						<>
							<ResizablePanel
								defaultSize={panels.preview}
								minSize={30}
								className="min-h-0 min-w-0 flex-1"
							>
								{centerPreview}
							</ResizablePanel>
							<ResizableHandle withHandle />
						</>
					)}

					<ResizablePanel
						defaultSize={isClassic ? panels.properties : 100 - rightPanels.tools}
						minSize={isClassic ? 15 : 30}
						maxSize={isClassic ? 40 : 70}
						className="min-w-0"
					>
						<PropertiesPanel />
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>

			<ResizableHandle withHandle />

			<ResizablePanel
				defaultSize={timelineSize}
				minSize={isClassic ? 15 : 25}
				maxSize={70}
				className={isClassic ? "min-h-0 px-3 pb-3" : "min-h-0"}
			>
				<Timeline />
			</ResizablePanel>
		</ResizablePanelGroup>
	);
}
