import type { TimelineManager } from "@/core/managers/timeline-manager";
import { finishFocusedField } from "@/utils/browser";

export interface ColorDragBaseline {
	color: string;
	restore?: () => void;
}

type ColorDragPoint = Pick<PointerEvent, "clientX" | "clientY">;

export function startColorDrag({
	target,
	startEvent,
	readBaseline,
	createColorReader,
	onPreview,
	onCommit,
	onEnd,
	beginGesture,
}: {
	target: HTMLButtonElement;
	startEvent: ColorDragPoint & Pick<PointerEvent, "pointerId">;
	readBaseline: () => ColorDragBaseline;
	createColorReader: (color: string) => (point: ColorDragPoint) => string | null;
	onPreview?: (color: string) => void;
	onCommit?: (color: string) => void;
	onEnd: (canceled: boolean) => void;
	beginGesture?: TimelineManager["beginPreviewGesture"];
}): () => void {
	finishFocusedField(target);
	const { pointerId } = startEvent;
	const view = target.ownerDocument.defaultView;
	let active = true;
	let latestColor: string | null = null;

	function move(point: ColorDragPoint) {
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
		onEnd(canceled);
		if (color === null) return;
		if (canceled) restore?.();
		else onCommit?.(color);
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
	const { color: baseline, restore } = readBaseline();
	const getColor = createColorReader(baseline);
	target.addEventListener("pointermove", handleMove);
	target.addEventListener("pointerup", handleUp);
	target.addEventListener("pointercancel", handleCancel);
	target.addEventListener("lostpointercapture", handleCancel);
	view?.addEventListener("blur", cancel);
	target.setPointerCapture(pointerId);
	move(startEvent);
	return cancel;
}
