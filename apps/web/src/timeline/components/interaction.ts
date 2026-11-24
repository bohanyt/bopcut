export const TIMELINE_DRAG_THRESHOLD_PX = 5;
export const TIMELINE_HORIZONTAL_WHEEL_STEP_PX = 40;
export const TIMELINE_ZOOM_BUTTON_FACTOR = 1.7;
export const TIMELINE_ZOOM_ANCHOR_PLAYHEAD_THRESHOLD = 0.15;

/** How the wheel scrolls the timeline. Alt turns a normal wheel sideways at full speed; Shift moves in small steps. */
export function getWheelScroll({
	deltaX,
	deltaY,
	deltaMode,
	shiftKey,
	altKey,
}: Pick<
	WheelEvent,
	"deltaX" | "deltaY" | "deltaMode" | "shiftKey" | "altKey"
>): { axis: "x" | "y"; delta: number } {
	const isSideways = Math.abs(deltaX) > Math.abs(deltaY);
	if (altKey) {
		const raw = isSideways ? deltaX : deltaY;
		return { axis: "x", delta: deltaMode === 1 ? raw * 16 : raw };
	}
	if (!shiftKey && !isSideways) return { axis: "y", delta: deltaY };

	const raw = isSideways ? deltaX : deltaY;
	return {
		axis: "x",
		delta:
			Math.sign(raw) *
			Math.min(Math.abs(raw), TIMELINE_HORIZONTAL_WHEEL_STEP_PX),
	};
}
