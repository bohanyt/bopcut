import type { PointerEvent } from "react";

type CaptureEvent = Pick<PointerEvent, "currentTarget" | "pointerId">;

export class PreviewPointerCapture {
	private release: (() => void) | null = null;

	get isActive(): boolean {
		return this.release !== null;
	}

	tryCapture({ currentTarget, pointerId }: CaptureEvent): (() => void) | null {
		if (this.isActive) return null;
		currentTarget.setPointerCapture(pointerId);
		const release = () => {
			if (this.release !== release) return;
			this.release = null;
			if (currentTarget.hasPointerCapture(pointerId)) {
				currentTarget.releasePointerCapture(pointerId);
			}
		};
		this.release = release;
		return release;
	}
}

type Point = { x: number; y: number };
type PanEvent = CaptureEvent & Pick<PointerEvent, "clientX" | "clientY">;

export class PreviewPan {
	private session: {
		center: Point;
		start: Point;
		pointerId: number;
		release: () => void;
	} | null = null;

	constructor(private capture: PreviewPointerCapture) {}

	start(event: PanEvent, center: Point): boolean {
		const release = this.capture.tryCapture(event);
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
