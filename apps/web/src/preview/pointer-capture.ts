import type { PointerEvent as ReactPointerEvent } from "react";

type CaptureEvent = Pick<ReactPointerEvent, "currentTarget" | "pointerId">;

export class PreviewPointerCapture {
	private release: (() => void) | null = null;

	get isActive(): boolean {
		return this.release !== null;
	}

	tryCapture(
		{ currentTarget, pointerId }: CaptureEvent,
		onLostCapture: () => void,
	): (() => void) | null {
		if (this.isActive) return null;
		const { ownerDocument } = currentTarget;
		currentTarget.setPointerCapture(pointerId);
		const release = () => {
			if (this.release !== release) return;
			this.release = null;
			ownerDocument.removeEventListener("lostpointercapture", handleLostCapture, true);
			if (currentTarget.hasPointerCapture(pointerId)) {
				currentTarget.releasePointerCapture(pointerId);
			}
		};
		const handleLostCapture = (event: PointerEvent) => {
			if (event.pointerId !== pointerId || currentTarget.hasPointerCapture(pointerId)) return;
			if (event.target !== currentTarget && event.target !== ownerDocument) return;
			release();
			onLostCapture();
		};
		this.release = release;
		// When a captured handle leaves the DOM, the browser dispatches loss on its document.
		ownerDocument.addEventListener("lostpointercapture", handleLostCapture, true);
		return release;
	}
}

type Point = { x: number; y: number };
type PanEvent = CaptureEvent & Pick<ReactPointerEvent, "clientX" | "clientY">;

export class PreviewPan {
	private session: {
		center: Point;
		start: Point;
		pointerId: number;
		release: () => void;
	} | null = null;

	constructor(private capture: PreviewPointerCapture) {}

	start(event: PanEvent, center: Point, onLostCapture: () => void): boolean {
		const release = this.capture.tryCapture(event, () => {
			if (this.finish(event)) onLostCapture();
		});
		if (!release) return false;
		this.session = {
			center,
			start: { x: event.clientX, y: event.clientY },
			pointerId: event.pointerId,
			release,
		};
		return true;
	}

	move(event: PanEvent, scale: number): Point | null {
		const session = this.session;
		if (!session || session.pointerId !== event.pointerId) return null;
		return {
			x: session.center.x - (event.clientX - session.start.x) / scale,
			y: session.center.y - (event.clientY - session.start.y) / scale,
		};
	}

	finish(event?: Pick<PanEvent, "pointerId">): boolean {
		const session = this.session;
		if (!session || (event && session.pointerId !== event.pointerId)) return false;
		this.session = null;
		session.release();
		return true;
	}
}
