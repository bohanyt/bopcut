import { useLayoutEffect, useState, type RefObject } from "react";
import { getTimelinePixelsPerSecond } from "@/timeline/pixel-utils";
import { TICKS_PER_SECOND } from "@/wasm";

const WINDOW_STEP_PX = 256;
const WINDOW_MARGIN_PX = 256;

export function useClipWindow({
	scrollRef,
	zoomLevel,
	fallbackWidth,
}: {
	scrollRef: RefObject<HTMLDivElement | null>;
	zoomLevel: number;
	fallbackWidth: number;
}) {
	const [viewport, setViewport] = useState({ left: 0, width: 0 });

	useLayoutEffect(() => {
		const node = scrollRef.current;
		if (!node) return;

		let frame: number | null = null;
		const readViewport = () => {
			const left =
				Math.floor(node.scrollLeft / WINDOW_STEP_PX) * WINDOW_STEP_PX;
			const width = node.clientWidth;
			setViewport((previous) =>
				previous.left === left && previous.width === width
					? previous
					: { left, width },
			);
		};
		const scheduleRead = () => {
			if (frame !== null) return;
			frame = requestAnimationFrame(() => {
				frame = null;
				readViewport();
			});
		};

		// Reconcile immediately after the parent applies the zoom scroll anchor.
		readViewport();
		const resize = new ResizeObserver(scheduleRead);
		resize.observe(node);
		node.addEventListener("scroll", scheduleRead, { passive: true });
		return () => {
			node.removeEventListener("scroll", scheduleRead);
			resize.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
		};
	}, [scrollRef, zoomLevel]);

	const ticksPerPixel =
		TICKS_PER_SECOND / getTimelinePixelsPerSecond({ zoomLevel });
	const width = viewport.width || fallbackWidth;
	return {
		viewportWidth: viewport.width,
		windowStart: Math.floor((viewport.left - WINDOW_MARGIN_PX) * ticksPerPixel),
		windowEnd: Math.ceil(
			(viewport.left + width + WINDOW_STEP_PX + WINDOW_MARGIN_PX) *
				ticksPerPixel,
		),
	};
}
