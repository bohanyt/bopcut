"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { useI18n } from "@/i18n/provider";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import type { ElementRef } from "@/timeline/types";
import { followFace, type FollowFailure } from "../apply-face-follow";

/** The facecam clip waiting for a click on the nose, or null. */
export const useFacePick = create<{ clip: ElementRef | null }>(() => ({ clip: null }));

const FAILURES = {
	"not-a-window": "reframe.followNotWindow",
	"no-media": "reframe.followNoMedia",
	outside: "reframe.followOutside",
	gone: "reframe.followGone",
} as const satisfies Record<FollowFailure, string>;

/** Over the preview while a nose is picked: one click starts the follow, Escape cancels. */
export function FacePickLayer() {
	const clip = useFacePick((state) => state.clip);
	const viewport = usePreviewViewport();
	const editor = useEditor();
	const { t } = useI18n();
	useEffect(() => {
		if (!clip) return;
		const cancel = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopImmediatePropagation();
			useFacePick.setState({ clip: null });
		};
		window.addEventListener("keydown", cancel, true);
		return () => window.removeEventListener("keydown", cancel, true);
	}, [clip]);
	if (!clip) return null;

	const follow = async (point: { x: number; y: number }) => {
		const id = toast.loading(t("reframe.following", { percent: 0 }));
		try {
			const result = await followFace(editor, {
				clip, point,
				onProgress: (done, total) => toast.loading(t("reframe.following", { percent: Math.round((done / total) * 100) }), { id }),
			});
			toast.dismiss(id);
			if (!result.ok) {
				toast.error(t(FAILURES[result.reason]));
				return;
			}
			toast.success(t("reframe.followed", { keys: result.keys }));
			if (result.lostShare > 0.2) toast.warning(t("reframe.followLost", { percent: Math.round(result.lostShare * 100) }));
		} catch (error) {
			toast.dismiss(id);
			toast.error(t("reframe.followNoMedia"), { description: error instanceof Error ? error.message : String(error) });
		}
	};

	return (
		<div
			role="application"
			aria-label={t("reframe.clickNose")}
			className="absolute inset-0 z-40 cursor-crosshair touch-none"
			onPointerDown={(event) => {
				if (event.button !== 0 || !event.isPrimary) return;
				event.preventDefault();
				event.stopPropagation();
				const point = viewport.screenToCanvas({ clientX: event.clientX, clientY: event.clientY });
				useFacePick.setState({ clip: null });
				if (point) void follow(point);
			}}
		>
			<div className="bg-popover pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-md border px-3 py-1.5 text-xs shadow">
				{t("reframe.clickNose")}
			</div>
		</div>
	);
}
