export function listenForTimelineMouseDrag({
	onMove,
	onRelease,
	onCancel,
}: {
	onMove: (event: MouseEvent) => void;
	onRelease: (event: MouseEvent) => void;
	onCancel: () => void;
}): () => void {
	const page = document;
	const view = page.defaultView;
	const release = (event: MouseEvent) => {
		if (event.button === 0) onRelease(event);
	};
	page.addEventListener("mousemove", onMove);
	page.addEventListener("mouseup", release);
	view?.addEventListener("blur", onCancel);
	return () => {
		page.removeEventListener("mousemove", onMove);
		page.removeEventListener("mouseup", release);
		view?.removeEventListener("blur", onCancel);
	};
}
