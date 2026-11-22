"use client";

import { localizeErrorDetail } from "@/i18n/error-details";

import { useI18n } from "@/i18n/provider";

import {
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { useEditor } from "@/editor/use-editor";
import type { PreviewOverlayControl } from "@/preview/overlays";
import { useEffect } from "react";
import { changeGroup } from "@/preview/group-actions";
import { toast } from "sonner";

export function PreviewContextMenu({
	onToggleFullscreen,
	container,
	overlayControls,
	onOverlayVisibilityChange,
}: {
	onToggleFullscreen: () => void;
	container: HTMLElement | null;
	overlayControls: PreviewOverlayControl[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const { t } = useI18n();
	const editor = useEditor();
	const viewport = usePreviewViewport();
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (
				target?.isContentEditable ||
				/^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "")
			)
				return;
			if (
				(event.ctrlKey || event.metaKey) &&
				event.key.toLowerCase() === "g" &&
				!event.altKey
			) {
				event.preventDefault();
				changeGroup(editor, event.shiftKey);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [editor]);

	const handleCopySnapshot = async () => {
		const result = await editor.renderer.copySnapshot();

		if (!result.success) {
			toast.error(t("preview.copySnapshotFailed"), {
				description: result.error ? localizeErrorDetail(result.error, t) : t("common.tryAgain"),
			});
			return;
		}
	};

	const handleSaveSnapshot = async () => {
		const result = await editor.renderer.saveSnapshot();

		if (!result.success) {
			toast.error(t("preview.saveSnapshotFailed"), {
				description: result.error ? localizeErrorDetail(result.error, t) : t("common.tryAgain"),
			});
			return;
		}
	};

	return (
		<ContextMenuContent className="min-w-56" container={container}>
			<ContextMenuItem onClick={() => changeGroup(editor, false)} inset>
				{t("preview.groupShortcut")}
			</ContextMenuItem>
			<ContextMenuItem onClick={() => changeGroup(editor, true)} inset>
				{t("preview.ungroupShortcut")}
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={viewport.fitToScreen} inset>
				{t("preview.fitToScreen")}
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={onToggleFullscreen} inset>
				{t("preview.fullScreenMenu")}
			</ContextMenuItem>
			<ContextMenuItem onClick={handleSaveSnapshot} inset>
				{t("preview.saveSnapshot")}
			</ContextMenuItem>
			<ContextMenuItem onClick={handleCopySnapshot} inset>
				{t("preview.copySnapshot")}
			</ContextMenuItem>
			{overlayControls.length > 0 ? <ContextMenuSeparator /> : null}
			{overlayControls.map((overlayControl) => (
				<ContextMenuCheckboxItem
					key={overlayControl.id}
					checked={overlayControl.isVisible}
					onCheckedChange={(checked) =>
						onOverlayVisibilityChange({
							overlayId: overlayControl.id,
							isVisible: !!checked,
						})
					}
				>
					{t(overlayControl.labelKey)}
				</ContextMenuCheckboxItem>
			))}
		</ContextMenuContent>
	);
}
