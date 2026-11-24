import { useEffect } from "react";
import { startEdgeAutoScroll } from "@/timeline/edge-auto-scroll";

interface UseEdgeAutoScrollParams {
	isActive: boolean;
	getMouseClientX: () => number;
	rulerScrollRef: React.RefObject<HTMLDivElement | null>;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	contentWidth: number;
	edgeThreshold?: number;
	maxScrollSpeed?: number;
}

export function useEdgeAutoScroll({
	isActive,
	getMouseClientX,
	rulerScrollRef,
	tracksScrollRef,
	contentWidth,
	edgeThreshold,
	maxScrollSpeed,
}: UseEdgeAutoScrollParams): void {
	useEffect(() => {
		if (!isActive) return;
		return startEdgeAutoScroll({
			getMouseClientX,
			getRulerViewport: () => rulerScrollRef.current,
			getTracksViewport: () => tracksScrollRef.current,
			getContentWidth: () => contentWidth,
			edgeThreshold,
			maxScrollSpeed,
		});
	}, [
		isActive,
		getMouseClientX,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth,
		edgeThreshold,
		maxScrollSpeed,
	]);
}
