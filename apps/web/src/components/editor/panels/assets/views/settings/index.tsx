"use client";

import { useI18n } from "@/i18n/provider";
import { getCanvasIssueMessage } from "@/i18n/canvas-messages";
import { useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { FPS_PRESETS, getCurrentFpsOption } from "@/fps/presets";
import { floatToFrameRate } from "@/fps/utils";
import { useEditor } from "@/editor/use-editor";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { BackgroundContent } from "./background";
import { ProxySettings } from "./proxies";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { useEditorStore } from "@/editor/editor-store";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/utils/ui";
import { dimensionToAspectRatio } from "@/utils/geometry";
import { formatNumberForDisplay, parseDecimalInput } from "@/utils/math";
import { OcSquarePlusIcon } from "@/components/icons";
import type { TCanvasSize } from "@/project/types";
import { toast } from "sonner";
import { getCanvasSizeIssue, getRendererLimits } from "@/services/renderer/renderer-device";
import { MIN_GPU_CANVAS_DIMENSION } from "@/canvas/sizes";

type SettingsView = "project-info" | "background";

const SETTINGS_TAB_CLASS = "h-auto min-h-6.5 min-w-0 max-w-full wrap-anywhere whitespace-normal px-1.5";

function isSettingsView(value: string): value is SettingsView {
	return value === "project-info" || value === "background";
}

const PRESET_LABELS: Record<string, string> = {
	"1:1": "1:1",
	"16:9": "16:9",
	"9:16": "9:16",
	"4:3": "4:3",
};

function areCanvasSizesEqual({
	left,
	right,
}: {
	left: TCanvasSize;
	right: TCanvasSize;
}) {
	return left.width === right.width && left.height === right.height;
}

function formatCanvasDimension({ value }: { value: number }) {
	return formatNumberForDisplay({ value, maxFractionDigits: 0 });
}

function parseCanvasDimension({ input }: { input: string }): number | null {
	const parsed = parseDecimalInput({ input });
	if (parsed === null) return null;

	const rounded = Math.round(parsed);
	return rounded > 0 ? rounded : null;
}

function customCanvasSizeError(size: TCanvasSize, changedDimension?: keyof TCanvasSize) {
	// Let users repair the two sides of an oversized saved canvas independently.
	const changedSize = changedDimension ? { width: 1, height: 1, [changedDimension]: size[changedDimension] } : size;
	const { maxSurfaceDimension } = getRendererLimits();
	if (getCanvasSizeIssue(changedSize, maxSurfaceDimension)) return getCanvasSizeIssue(size, maxSurfaceDimension);
	if (maxSurfaceDimension === undefined && Math.max(changedSize.width, changedSize.height) > MIN_GPU_CANVAS_DIMENSION) {
		return { kind: "graphicsNotReady", max: MIN_GPU_CANVAS_DIMENSION } as const;
	}
}

function useCanvasDimensionDraft({
	value,
	onCommit,
}: {
	value: number;
	onCommit: (value: number) => void;
}) {
	return usePropertyDraft({
		displayValue: formatCanvasDimension({ value }),
		parse: (input) => parseCanvasDimension({ input }),
		onCommit: (nextValue) => {
			if (nextValue !== value) onCommit(nextValue);
		},
	});
}

export function SettingsView() {
	const { t } = useI18n();
	const [view, setView] = useState<SettingsView>("project-info");
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const fpsOption = getCurrentFpsOption(activeProject.settings.fps);
	const fpsOptions = FPS_PRESETS.some(({ value }) => value === fpsOption.value)
		? FPS_PRESETS
		: [...FPS_PRESETS, fpsOption];
	const { canvasPresets } = useEditorStore();
	const currentCanvasSize = activeProject.settings.canvasSize;
	const canvasSizeMode = activeProject.settings.canvasSizeMode ?? "preset";
	const lastCustomCanvasSize =
		activeProject.settings.lastCustomCanvasSize ?? null;

	const presetItems = canvasPresets.map((preset, index) => {
		const ratio = dimensionToAspectRatio(preset);
		return {
			id: index.toString(),
			label: PRESET_LABELS[ratio] ?? ratio,
			ratio,
			canvasSize: preset,
		};
	});

	const selectedPresetId = canvasSizeMode === "preset"
		? (presetItems.find((preset) =>
				areCanvasSizesEqual({
					left: preset.canvasSize,
					right: currentCanvasSize,
				}),
			)?.id ?? null)
		: null;

	const updateCustomCanvasSize = ({
		canvasSize,
	}: {
		canvasSize: TCanvasSize;
	}) => {
		const shouldUpdateCanvasSize = !areCanvasSizesEqual({
			left: canvasSize,
			right: currentCanvasSize,
		});
		const shouldUpdateLastCustomCanvasSize =
			lastCustomCanvasSize === null ||
			!areCanvasSizesEqual({
				left: canvasSize,
				right: lastCustomCanvasSize,
			});
		const shouldUpdateCanvasSizeMode = canvasSizeMode !== "custom";

		if (
			!shouldUpdateCanvasSize &&
			!shouldUpdateLastCustomCanvasSize &&
			!shouldUpdateCanvasSizeMode
		) {
			return;
		}

		editor.project.updateSettings({
			settings: {
				...(shouldUpdateCanvasSize ? { canvasSize } : {}),
				...(shouldUpdateCanvasSizeMode
					? { canvasSizeMode: "custom" as const }
					: {}),
				lastCustomCanvasSize: canvasSize,
			},
		});
	};

	const selectPresetCanvasSize = ({
		canvasSize,
	}: {
		canvasSize: TCanvasSize;
	}) => {
		const shouldUpdateCanvasSize = !areCanvasSizesEqual({
			left: canvasSize,
			right: currentCanvasSize,
		});
		const shouldUpdateCanvasSizeMode = canvasSizeMode !== "preset";

		if (!shouldUpdateCanvasSize && !shouldUpdateCanvasSizeMode) return;

		editor.project.updateSettings({
			settings: {
				...(shouldUpdateCanvasSize ? { canvasSize } : {}),
				...(shouldUpdateCanvasSizeMode
					? { canvasSizeMode: "preset" as const }
					: {}),
			},
		});
	};

	const selectCustomCanvasSize = () => {
		const canvasSize = lastCustomCanvasSize ?? currentCanvasSize;
		if (customCanvasSizeError(canvasSize)) {
			// Open the fields at the current size and keep the preference for a capable device.
			if (canvasSizeMode !== "custom") {
				editor.project.updateSettings({ settings: { canvasSizeMode: "custom" } });
			}
			return;
		}
		updateCustomCanvasSize({ canvasSize });
	};

	const commitDimension = (dimension: keyof TCanvasSize, value: number) => {
		const canvasSize = { ...currentCanvasSize, [dimension]: value };
		const error = customCanvasSizeError(canvasSize, dimension);
		if (error) {
			toast.error(
				error.kind === "graphicsNotReady"
					? t("settings.graphicsNotReady", { max: error.max })
					: getCanvasIssueMessage(error, t),
			);
			return;
		}
		updateCustomCanvasSize({ canvasSize });
	};

	const widthDraft = useCanvasDimensionDraft({
		value: currentCanvasSize.width,
		onCommit: (width) => commitDimension("width", width),
	});

	const heightDraft = useCanvasDimensionDraft({
		value: currentCanvasSize.height,
		onCommit: (height) => commitDimension("height", height),
	});

	const isCustomSelected = canvasSizeMode === "custom";

	return (
		<PanelView
			headerClassName="h-auto min-h-11 px-1.5 py-1"
			contentClassName="px-0"
			scrollClassName="pt-0"
			actions={
				<Tabs
					className="min-w-0"
					value={view}
					onValueChange={(value) => {
						if (isSettingsView(value)) {
							setView(value);
						}
					}}
				>
					<TabsList className="flex flex-wrap gap-1">
						<TabsTrigger value="project-info" className={SETTINGS_TAB_CLASS}>
							{t("settings.projectInfo")}
						</TabsTrigger>
						<TabsTrigger value="background" className={SETTINGS_TAB_CLASS}>
							{t("settings.background")}
						</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			{view === "project-info" && (
				<div className="flex flex-col">
					<ProxySettings />
					<Section showTopBorder={false}>
						<SectionHeader>
							<SectionTitle className="flex-1">{t("common.name")}</SectionTitle>
							<span className="min-w-0 text-sm truncate">
								{activeProject.metadata.name}
							</span>
						</SectionHeader>
					</Section>
					<Section showTopBorder={false}>
						<SectionHeader className="justify-between">
							<SectionTitle className="flex-1">{t("settings.frameRate")}</SectionTitle>
							<Select
								value={fpsOption.value}
								onValueChange={(value) => {
									if (value === fpsOption.value) return;
									const fps = floatToFrameRate(Number(value));
									editor.project.updateSettings({ settings: { fps } });
								}}
							>
								<SelectTrigger
									className="bg-transparent border-none p-1 h-auto"
									aria-label={t("settings.frameRate")}
								>
									<SelectValue placeholder={t("settings.selectFrameRate")} />
								</SelectTrigger>
								<SelectContent>
									{fpsOptions.map((preset) => (
										<SelectItem key={preset.value} value={preset.value}>
											{preset.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionHeader>
					</Section>
					<Section
						showTopBorder={false}
						collapsible
						sectionKey="settings:aspect-ratio"
					>
						<SectionHeader>
							<SectionTitle className="flex-1">{t("settings.aspectRatio")}</SectionTitle>
						</SectionHeader>
						<SectionContent className="px-2 flex flex-col gap-1 pb-2">
							{presetItems.map((preset) => (
								<AspectRatioItem
									key={preset.id}
									label={preset.label}
									previewIcon={<AspectRatioPreview ratio={preset.ratio} />}
									isSelected={selectedPresetId === preset.id}
									onClick={() => {
										selectPresetCanvasSize({
											canvasSize: preset.canvasSize,
										});
									}}
								/>
							))}
							<div className="pb-2">
								<AspectRatioItem
									label={t("common.custom")}
									previewIcon={<OcSquarePlusIcon />}
									isSelected={isCustomSelected}
									onClick={selectCustomCanvasSize}
									className={isCustomSelected ? "rounded-b-none border-b-0" : undefined}
								/>
								{isCustomSelected && (
									<div className="flex items-center gap-2 rounded-b-md border border-t-0 border-secondary-border bg-secondary px-2 pb-2 text-foreground">
										<NumberField
											value={widthDraft.displayValue}
											className="w-full min-w-0"
											aria-label={t("settings.canvasWidth")}
											onFocus={widthDraft.onFocus}
											onChange={widthDraft.onChange}
											onBlur={widthDraft.onBlur}
										/>
										<NumberField
											value={heightDraft.displayValue}
											className="w-full min-w-0"
											aria-label={t("settings.canvasHeight")}
											onFocus={heightDraft.onFocus}
											onChange={heightDraft.onChange}
											onBlur={heightDraft.onBlur}
										/>
									</div>
								)}
							</div>
						</SectionContent>
					</Section>
				</div>
			)}
			{view === "background" && <BackgroundContent />}
		</PanelView>
	);
}

function AspectRatioItem({
	label,
	previewIcon,
	isSelected,
	onClick,
	className,
}: {
	label: string;
	previewIcon: React.ReactNode;
	isSelected: boolean;
	onClick: () => void;
	className?: string;
}) {
	return (
		<Button
			variant={isSelected ? "secondary" : "ghost"}
			className={cn(
				"px-2 py-0 flex flex-col h-fit w-full",
				!isSelected && "border border-transparent opacity-75!",
				className,
			)}
			onClick={onClick}
		>
			<div className="w-full flex justify-between items-center h-8">
				<div className="flex-1 flex items-center gap-2">
					<div className="flex items-center justify-center size-5">
						{previewIcon}
					</div>
					<span className="min-w-0 text-sm truncate">{label}</span>
				</div>
				<div>
					{isSelected && <HugeiconsIcon icon={Tick02Icon} className="size-4" />}
				</div>
			</div>
		</Button>
	);
}

function AspectRatioPreview({ ratio }: { ratio?: string }) {
	if (!ratio) return null;

	const [w, h] = ratio.split(":").map(Number);
	const maxSize = 16;
	const width = w >= h ? maxSize : (w / h) * maxSize;
	const height = h >= w ? maxSize : (h / w) * maxSize;

	return (
		<div
			style={{ width, height, borderWidth: 1.5 }}
			className="rounded-xs border-current opacity-60"
		/>
	);
}
