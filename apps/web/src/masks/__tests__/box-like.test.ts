import { expect, test } from "bun:test";
import { computeBoxMaskParamUpdate } from "@/masks/builtin/box-like";
import type { MaskHandleId, RectangleMaskParams } from "@/masks/types";
import type { ElementBounds } from "@/preview/element-bounds";

const bounds: ElementBounds = { cx: 500, cy: 500, width: 1000, height: 1000, rotation: 0 };
const square = (rotation: number) =>
	({ centerX: 0, centerY: 0, width: 0.5, height: 0.5, rotation, scale: 1, feather: 0 }) as RectangleMaskParams;

function drag(handleId: MaskHandleId, startParams: RectangleMaskParams, start: [number, number], delta: [number, number]) {
	return computeBoxMaskParamUpdate({
		handleId, startParams, bounds, canvasSize: { width: 1000, height: 1000 },
		startCanvasX: start[0], startCanvasY: start[1], deltaX: delta[0], deltaY: delta[1],
	});
}

test("the rotation handle turns a box mask by the angle swept around its center", () => {
	// From the handle above the center to a point right of it is a quarter turn.
	expect(drag({ kind: "rotation" }, square(0), [500, 200], [300, 300]).rotation).toBeCloseTo(90, 5);
	expect(drag({ kind: "rotation" }, square(350), [500, 200], [-300, 300]).rotation).toBeCloseTo(260, 5);
});

test("edge and corner handles resize along the rotated mask's own axes", () => {
	// Unrotated: the right edge follows the pointer along X.
	expect(drag({ kind: "edge", side: "right" }, square(0), [750, 500], [40, 0]).width).toBeCloseTo(0.58, 5);
	// Rotated a quarter turn, the right edge faces down: a downward drag widens it, a sideways one does not.
	expect(drag({ kind: "edge", side: "right" }, square(90), [500, 750], [0, 40]).width).toBeCloseTo(0.58, 5);
	expect(drag({ kind: "edge", side: "right" }, square(90), [500, 750], [40, 0]).width).toBeCloseTo(0.5, 5);
	expect(drag({ kind: "edge", side: "top" }, square(90), [750, 500], [40, 0]).height).toBeCloseTo(0.58, 5);
	// The bottom-right corner of a quarter-turned mask points down-left; dragging that way grows it.
	const corner = drag({ kind: "corner", corner: { x: "right", y: "bottom" } }, square(90), [250, 750], [-20, 20]);
	expect(corner.width).toBeCloseTo(0.52, 5);
	expect(corner.height).toBeCloseTo(corner.width!, 5);
});
