import type { TimelineManager } from "@/core/managers/timeline-manager";

export function startColorDrag({
	target,
	startEvent,
	getColor,
	onPreview,
	onCommit,
	onEnd,
	beginGesture,
}: {
	target: HTMLButtonElement;
	startEvent: Pick<PointerEvent, "pointerId" | "clientX" | "clientY">;
	getColor: (point: Pick<PointerEvent, "clientX" | "clientY">) => string | null;
	onPreview?: (color: string) => void;
	onCommit?: (color: string) => void;
	onEnd: (canceled: boolean, previewed: boolean) => void;
	beginGesture?: TimelineManager["beginPreviewGesture"];
}): () => void {
	const { pointerId } = startEvent;
	const view = target.ownerDocument.defaultView;
	let active = true;
	let latestColor: string | null = null;

	function move(point: Pick<PointerEvent, "clientX" | "clientY">) {
		const color = getColor(point);
		if (color === null) return;
		latestColor = color;
		onPreview?.(color);
	}

	function finish(canceled: boolean) {
		if (!active) return;
		active = false;
		target.removeEventListener("pointermove", handleMove);
		target.removeEventListener("pointerup", handleUp);
		target.removeEventListener("pointercancel", handleCancel);
		target.removeEventListener("lostpointercapture", handleCancel);
		view?.removeEventListener("blur", cancel);
		if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
		const color = latestColor;
		latestColor = null;
		if (!canceled) owner?.finish();
		onEnd(canceled, color !== null);
		if (!canceled && color !== null) onCommit?.(color);
	}

	function cancel() {
		if (owner) owner.cancel();
		else finish(true);
	}

	function handleMove(event: PointerEvent) {
		if (event.pointerId === pointerId) move(event);
	}

	function handleUp(event: PointerEvent) {
		if (event.pointerId === pointerId) finish(false);
	}

	function handleCancel(event: PointerEvent) {
		if (event.pointerId === pointerId) cancel();
	}

	const owner = beginGesture?.(() => finish(true));
	target.addEventListener("pointermove", handleMove);
	target.addEventListener("pointerup", handleUp);
	target.addEventListener("pointercancel", handleCancel);
	target.addEventListener("lostpointercapture", handleCancel);
	view?.addEventListener("blur", cancel);
	target.setPointerCapture(pointerId);
	move(startEvent);
	return cancel;
}
