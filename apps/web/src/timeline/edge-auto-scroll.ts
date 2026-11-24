export function startEdgeAutoScroll({
	getMouseClientX,
	getRulerViewport,
	getTracksViewport,
	getContentWidth,
	edgeThreshold = 100,
	maxScrollSpeed = 15,
}: {
	getMouseClientX: () => number;
	getRulerViewport: () => HTMLDivElement | null;
	getTracksViewport: () => HTMLDivElement | null;
	getContentWidth: () => number;
	edgeThreshold?: number;
	maxScrollSpeed?: number;
}): () => void {
	const step = () => {
		const ruler = getRulerViewport();
		const tracks = getTracksViewport();
		if (ruler && tracks) {
			const pointer = getMouseClientX() - ruler.getBoundingClientRect().left;
			const width = ruler.clientWidth;
			const left = ruler.scrollLeft;
			const distanceFromRight = width - pointer;

			if (pointer < edgeThreshold || distanceFromRight < edgeThreshold) {
				const maxScroll = Math.max(
					0,
					Math.max(getContentWidth(), ruler.scrollWidth) - width,
				);
				let delta = 0;
				if (pointer < edgeThreshold && left > 0) {
					delta = -maxScrollSpeed * (1 - Math.max(0, pointer) / edgeThreshold);
				} else if (distanceFromRight < edgeThreshold && left < maxScroll) {
					delta = maxScrollSpeed * (1 - Math.max(0, distanceFromRight) / edgeThreshold);
				}
				if (delta !== 0) {
					const scrollLeft = Math.max(0, Math.min(maxScroll, left + delta));
					ruler.scrollLeft = scrollLeft;
					tracks.scrollLeft = scrollLeft;
				}
			}
		}
		frame = requestAnimationFrame(step);
	};
	let frame = requestAnimationFrame(step);
	return () => cancelAnimationFrame(frame);
}
