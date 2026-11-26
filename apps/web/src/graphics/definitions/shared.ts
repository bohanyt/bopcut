import type { ParamDefinition } from "@/params";

export type GraphicStrokeAlign = "inside" | "center" | "outside";

/**
 * How far a shape sits inside its box so that its stroke stays in the box: a center stroke reaches
 * half its width past the shape's edge, an outside stroke its whole width.
 */
export function strokeInset({
	strokeAlign,
	strokeWidth,
}: {
	strokeAlign: GraphicStrokeAlign;
	strokeWidth: number;
}): number {
	if (strokeAlign === "outside") return strokeWidth;
	return strokeAlign === "center" ? strokeWidth / 2 : 0;
}

export const STROKE_ALIGN_PARAM: ParamDefinition<"strokeAlign"> = {
	key: "strokeAlign",
	labelKey: "params.strokeAlign",
	type: "select",
	default: "center",
	group: "stroke",
	options: [
		{ value: "inside", labelKey: "params.inside" },
		{ value: "center", labelKey: "params.center" },
		{ value: "outside", labelKey: "params.outside" },
	],
};
