import type { ParamDefinition } from "@/params";

export type GraphicStrokeAlign = "inside" | "center" | "outside";

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
