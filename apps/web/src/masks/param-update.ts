import { FEATHER_HANDLE_SCALE, MAX_FEATHER } from "@/masks/feather";

export function computeFeatherUpdate({
	startFeather,
	deltaX,
	deltaY,
	directionX,
	directionY,
}: {
	startFeather: number;
	deltaX: number;
	deltaY: number;
	directionX: number;
	directionY: number;
}): { feather: number } {
	const projection = deltaX * directionX + deltaY * directionY;
	return {
		feather: Math.max(
			0,
			Math.min(
				MAX_FEATHER,
				Math.round(startFeather + projection / FEATHER_HANDLE_SCALE),
			),
		),
	};
}

/** A rotation drag turns the mask by the angle the pointer sweeps around the mask's center. */
export function computeRotationUpdate({
	startParams,
	deltaX,
	deltaY,
	startCanvasX,
	startCanvasY,
	bounds,
}: {
	startParams: { centerX: number; centerY: number; rotation: number };
	deltaX: number;
	deltaY: number;
	startCanvasX: number;
	startCanvasY: number;
	bounds: { cx: number; cy: number; width: number; height: number };
}): { rotation: number } {
	const pivotX = bounds.cx + startParams.centerX * bounds.width;
	const pivotY = bounds.cy + startParams.centerY * bounds.height;
	const startAngle = Math.atan2(startCanvasY - pivotY, startCanvasX - pivotX);
	const currentAngle = Math.atan2(startCanvasY + deltaY - pivotY, startCanvasX + deltaX - pivotX);
	let deltaAngle = ((currentAngle - startAngle) * 180) / Math.PI;
	if (deltaAngle > 180) deltaAngle -= 360;
	if (deltaAngle < -180) deltaAngle += 360;
	return { rotation: (((startParams.rotation + deltaAngle) % 360) + 360) % 360 };
}
