"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ScanLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditor } from "@/editor/use-editor";
import { useI18n } from "@/i18n/provider";
import { areaKeyAction, boxBetween, picturePoint, type BookmarkBox, type PicturePoint } from "@/timeline/bookmarks/area";
import { startBookmarkArea, useBookmarkArea } from "@/timeline/bookmarks/area-state";
import { generateUUID } from "@/utils/id";
import { usePreviewViewport } from "./preview-viewport";

const corners = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
const boxStyle = ({ x, y, width, height }: BookmarkBox) => ({
	left: `${x * 100}%`, top: `${y * 100}%`, width: `${width * 100}%`, height: `${height * 100}%`,
});

export function BookmarkAreaButton() {
	const { t } = useI18n();
	const editor = useEditor();
	const editing = useBookmarkArea((state) => state.editing !== null);
	useSyncExternalStore(editor.voiceOver.subscribe, editor.voiceOver.getSnapshot, editor.voiceOver.getServerSnapshot);
	return (
		<Button variant="text" disabled={editor.voiceOver.isCapturing()} aria-pressed={editing} aria-label={t("bookmark.pointArea")} title={t("bookmark.pointArea")}
			onClick={() => editing ? useBookmarkArea.setState({ editing: null }) : startBookmarkArea(editor, editor.playback.getCurrentTime())}>
			<ScanLine />
		</Button>
	);
}

export function BookmarkAreaLayer({ formHost }: { formHost: HTMLDivElement | null }) {
	const editing = useBookmarkArea((state) => state.editing);
	const shown = useBookmarkArea((state) => state.shown ?? state.hovered);
	const editor = useEditor();
	const scope = useEditor((e) => `${e.project.getSession()}:${e.project.getActiveOrNull()?.metadata.id}:${e.scenes.getActiveSceneOrNull()?.id}`);
	const { sceneLeft, sceneTop, sceneWidth, sceneHeight } = usePreviewViewport();
	const matches = (target: typeof editing) => target && scope === `${target.session}:${target.projectId}:${target.sceneId}`;
	useEffect(() => {
		if (editing && !matches(editing)) useBookmarkArea.setState({ editing: null });
	}, [editing, scope]);
	const style = { left: sceneLeft, top: sceneTop, width: sceneWidth, height: sceneHeight };
	if (editing && matches(editing)) {
		return <AreaEditor key={`${scope}:${editing.time}`} initial={editing.bookmark} style={style} formHost={formHost}
			onSave={(box, note) => {
				if (useBookmarkArea.getState().editing !== editing || editor.playback.getIsPlaying() ||
					editor.voiceOver.isCapturing() || editor.playback.getCurrentTime() !== editing.time) return;
				const { bookmark } = editing;
				void editor.scenes.updateBookmark({ time: editing.time, bookmark, create: true, updates: {
					box, note,
					...(!bookmark?.id && { id: generateUUID(), author: "user", createdAt: new Date().toISOString(), resolved: false }),
				} });
				useBookmarkArea.setState({ editing: null });
			}} />;
	}
	const box = shown && matches(shown) ? shown.bookmark?.box : undefined;
	return box ? <div className="pointer-events-none absolute z-30" style={style}><Box box={box} /></div> : null;
}

function Box({ box, children }: { box: BookmarkBox; children?: React.ReactNode }) {
	return <div className="absolute border-2 border-cyan-300 bg-cyan-400/10 shadow-[0_0_0_1px_#111]" style={boxStyle(box)}>{children}</div>;
}

function AreaEditor({ initial, style, onSave, formHost }: {
	initial?: import("@/timeline").Bookmark;
	style: React.CSSProperties;
	onSave: (box: BookmarkBox, note: string) => void;
	formHost: HTMLDivElement | null;
}) {
	const { t } = useI18n();
	const layer = useRef<HTMLDivElement>(null);
	const picture = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const drag = useRef<{ id: number; anchor: PicturePoint; previous?: BookmarkBox } | null>(null);
	const [box, setBox] = useState(initial?.box);
	const [note, setNote] = useState(initial?.note ?? "");
	const [drawing, setDrawing] = useState(false);
	const formBox = drawing ? undefined : box;
	const showForm = !!formBox;
	const cancel = () => useBookmarkArea.setState({ editing: null });
	const keydown = useEffectEvent((event: KeyboardEvent) => {
		event.stopImmediatePropagation();
		if (event.isComposing) return;
		const target = event.target instanceof HTMLElement ? event.target : null;
		const corner = target?.dataset.areaCorner;
		const action = areaKeyAction(event.key, target === input.current, corner !== undefined,
			event.ctrlKey || event.metaKey || event.altKey);
		if (action === "native") return;
		event.preventDefault();
		if (action === "cancel" || (action === "confirm" && target?.dataset.areaCancel !== undefined)) {
			cancel();
			return;
		}
		if (action === "confirm" && !drawing) {
			if (box && note.trim()) onSave(box, note.trim());
			else {
				if (!box) setBox(boxBetween({ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }));
				input.current?.focus({ preventScroll: true });
			}
		}
		if (action === "resize" && corner && box) {
			const [x, y] = corners[Number(corner)];
			const dx = Number(event.key === "ArrowRight") - Number(event.key === "ArrowLeft");
			const dy = Number(event.key === "ArrowDown") - Number(event.key === "ArrowUp");
			const step = event.shiftKey ? 0.05 : 0.01;
			setBox(boxBetween(
				{ x: box.x + (1 - x) * box.width, y: box.y + (1 - y) * box.height },
				{ x: box.x + x * box.width + dx * step, y: box.y + y * box.height + dy * step },
			));
		}
	});
	useLayoutEffect(() => {
		layer.current?.focus({ preventScroll: true });
		const key = (event: KeyboardEvent) => keydown(event);
		const blur = () => {
			const active = drag.current;
			if (!active) return;
			drag.current = null;
			if (layer.current?.hasPointerCapture(active.id)) layer.current.releasePointerCapture(active.id);
			setDrawing(false);
			setBox(active.previous);
		};
		window.addEventListener("keydown", key, true);
		window.addEventListener("blur", blur);
		return () => {
			window.removeEventListener("keydown", key, true);
			window.removeEventListener("blur", blur);
		};
	}, []);
	useLayoutEffect(() => {
		if (showForm) input.current?.focus({ preventScroll: true });
	}, [showForm, formHost]);

	const point = (event: React.PointerEvent) => picturePoint(
		{ x: event.clientX, y: event.clientY }, picture.current!.getBoundingClientRect(),
	);
	const start = (event: React.PointerEvent, anchor?: PicturePoint) => {
		if (event.button !== 0 || !event.isPrimary || drag.current) return;
		event.preventDefault();
		event.stopPropagation();
		drag.current = { id: event.pointerId, anchor: anchor ?? point(event), previous: box };
		layer.current?.setPointerCapture(event.pointerId);
		setDrawing(true);
		setBox(boxBetween(drag.current.anchor, point(event)));
	};
	const end = (event: React.PointerEvent, cancelled: boolean) => {
		if (drag.current?.id !== event.pointerId) return;
		const previous = drag.current.previous;
		setBox(cancelled ? previous : boxBetween(drag.current.anchor, point(event)));
		drag.current = null;
		setDrawing(false);
	};

	return <div ref={layer} tabIndex={0} aria-label={t("bookmark.pointArea")} className="absolute inset-0 z-40 touch-none"
		onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
		onPointerMove={(event) => { if (drag.current?.id === event.pointerId) setBox(boxBetween(drag.current.anchor, point(event))); }}
		onPointerUp={(event) => end(event, false)}
		onPointerCancel={(event) => end(event, true)}
		onLostPointerCapture={(event) => end(event, true)}>
		<div ref={picture} className="absolute cursor-crosshair" style={style} onPointerDown={(event) => start(event)}>
			{box && <Box box={box}>{corners.map(([x, y], index) => {
				const anchor = { x: box.x + (1 - x) * box.width, y: box.y + (1 - y) * box.height };
				return <button key={`${x}${y}`} type="button" aria-label={t("bookmark.resizeArea")} data-area-corner={index}
					className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black bg-cyan-300"
					style={{ left: `${x * 100}%`, top: `${y * 100}%`, cursor: x === y ? "nwse-resize" : "nesw-resize" }}
					onPointerDown={(event) => start(event, anchor)} />;
			})}</Box>}
		</div>
		{formBox && formHost && createPortal(<form className="mx-auto flex max-w-md flex-wrap items-center gap-1 rounded-md border bg-popover p-2"
			onSubmit={(event) => { event.preventDefault(); if (note.trim()) onSave(formBox, note.trim()); }}>
			<Input ref={input} className="h-8" containerClassName="min-w-28 flex-1" value={note} aria-label={t("bookmark.note")}
				placeholder={t("bookmark.addNote")} onChange={(event) => setNote(event.target.value)} />
			<Button size="sm" type="submit" disabled={!note.trim()}>{t("common.save")}</Button>
			<Button size="sm" type="button" data-area-cancel variant="outline" onClick={cancel}>{t("common.cancel")}</Button>
		</form>, formHost)}
	</div>;
}
