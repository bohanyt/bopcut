"use client";

import { useRef, useState } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useEditor } from "@/editor/use-editor";
import { useI18n } from "@/i18n/provider";
import type { ElementRef } from "@/timeline/types";
import { applySplitLayout, layoutCanvas } from "../apply-split-layout";
import { gameCropWidth, gameCropX, SPLIT_LIMITS, type SourceRect } from "../split-layout";

/** The clip whose split layout is being set up, or null. */
export const useSplitLayoutRequest = create<{ clip: ElementRef | null }>(() => ({ clip: null }));

/** Where most streams put a facecam: a guess to start from, moved by drawing a new box. */
const DEFAULT_FACECAM: SourceRect = { x: 0.02, y: 0.6, width: 0.26, height: 0.38 };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): SourceRect {
	const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
	return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Asks where the facecam is in the clip and how tall the game is, then makes the layout. Mounted once in the editor. */
export function SplitLayoutHost() {
	const clip = useSplitLayoutRequest((state) => state.clip);
	const editor = useEditor();
	const asset = useEditor((e) => {
		if (!clip) return null;
		const element = e.timeline.getElementsWithTracks({ elements: [clip] })[0]?.element;
		return element?.type === "video" ? e.media.getAssets().find(({ id }) => id === element.mediaId) ?? null : null;
	});
	const canvas = useEditor((e) => e.project.getActiveOrNull()?.settings.canvasSize ?? null);
	const { t } = useI18n();
	if (!clip || !asset?.width || !asset.height) return null;
	const close = () => useSplitLayoutRequest.setState({ clip: null });
	return (
		<SplitLayoutDialog
			key={`${clip.trackId}:${clip.elementId}`}
			still={asset.thumbnailUrl}
			aspect={asset.width / asset.height}
			canvas={layoutCanvas(canvas ?? { width: 1080, height: 1920 })}
			makesVertical={!!canvas && canvas.height <= canvas.width}
			onCancel={close}
			onConfirm={({ facecam, split, gameX }) => {
				close();
				if (!applySplitLayout(editor, { clip, facecam, split, gameX })) toast.error(t("reframe.failed"));
			}}
		/>
	);
}

export function SplitLayoutDialog({ still, aspect, canvas, makesVertical, onCancel, onConfirm }: {
	still?: string;
	/** The source's width over its height. */
	aspect: number;
	/** The canvas the layout is made for. */
	canvas: { width: number; height: number };
	makesVertical: boolean;
	onCancel: () => void;
	onConfirm: (choice: { facecam: SourceRect; split: number; gameX: number }) => void;
}) {
	const { t } = useI18n();
	const picture = useRef<HTMLDivElement>(null);
	const drag = useRef<{ id: number; anchor: { x: number; y: number } } | null>(null);
	const [facecam, setFacecam] = useState<SourceRect>(DEFAULT_FACECAM);
	const [split, setSplit] = useState<number>(SPLIT_LIMITS.default);
	// Where the game's crop starts: away from the facecam until the person moves it.
	const [chosenGameX, setChosenGameX] = useState<number | null>(null);
	const gameWidth = gameCropWidth({ media: { width: aspect, height: 1 }, canvas, split });
	const gameX = Math.min(1 - gameWidth, Math.max(0, chosenGameX ?? gameCropX({ facecam, width: gameWidth })));
	const point = (event: React.PointerEvent) => {
		const rect = picture.current!.getBoundingClientRect();
		return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
	};
	const usable = facecam.width > 0.02 && facecam.height > 0.02;

	return (
		<Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("reframe.title")}</DialogTitle>
					<DialogDescription>{t("reframe.drawFacecam")}</DialogDescription>
				</DialogHeader>
				<DialogBody className="gap-4">
					<div
						ref={picture}
						role="application"
						aria-label={t("reframe.facecamArea")}
						className="bg-muted relative w-full cursor-crosshair touch-none overflow-hidden rounded-md select-none"
						style={{ aspectRatio: String(aspect) }}
						onPointerDown={(event) => {
							if (event.button !== 0 || !event.isPrimary) return;
							event.preventDefault();
							drag.current = { id: event.pointerId, anchor: point(event) };
							event.currentTarget.setPointerCapture?.(event.pointerId);
							setFacecam(rectBetween(drag.current.anchor, drag.current.anchor));
						}}
						onPointerMove={(event) => {
							if (drag.current?.id === event.pointerId) setFacecam(rectBetween(drag.current.anchor, point(event)));
						}}
						onPointerUp={(event) => {
							if (drag.current?.id !== event.pointerId) return;
							setFacecam(rectBetween(drag.current.anchor, point(event)));
							drag.current = null;
						}}
					>
						{still && <img src={still} alt="" draggable={false} className="pointer-events-none absolute inset-0 size-full object-fill" />}
						{gameWidth < 1 && (
							<div
								data-game-crop
								className="pointer-events-none absolute inset-y-0 border-2 border-dashed border-white/90 shadow-[0_0_0_1px_#111]"
								style={{ left: `${gameX * 100}%`, width: `${gameWidth * 100}%` }}
							/>
						)}
						<div
							data-facecam-box
							className="pointer-events-none absolute border-2 border-cyan-300 bg-cyan-400/15 shadow-[0_0_0_1px_#111]"
							style={{ left: `${facecam.x * 100}%`, top: `${facecam.y * 100}%`, width: `${facecam.width * 100}%`, height: `${facecam.height * 100}%` }}
						/>
					</div>
					<label className="flex flex-col gap-1 text-sm">
						{t("reframe.gameShare", { percent: Math.round(split * 100) })}
						<input
							type="range"
							min={SPLIT_LIMITS.min}
							max={SPLIT_LIMITS.max}
							step={0.01}
							value={split}
							className="accent-primary"
							onChange={(event) => setSplit(Number(event.currentTarget.value))}
						/>
					</label>
					{gameWidth < 1 && (
						<label className="flex flex-col gap-1 text-sm">
							{t("reframe.gamePosition")}
							<input
								type="range"
								min={0}
								max={1}
								step={0.01}
								value={gameX / (1 - gameWidth)}
								className="accent-primary"
								onChange={(event) => setChosenGameX(Number(event.currentTarget.value) * (1 - gameWidth))}
							/>
						</label>
					)}
					{makesVertical && <p className="text-muted-foreground text-xs">{t("reframe.makesVertical")}</p>}
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
					<Button disabled={!usable} onClick={() => onConfirm({ facecam, split, gameX })}>{t("reframe.apply")}</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
