import { expect, test } from "bun:test";
import { Canvas, createCanvas } from "@napi-rs/canvas";
import { parseGradient } from "./parser";
import { drawCssBackground } from "./canvas";

test("gradient parser and canvas background fixes", () => {
	const toDeg = (code: string) => {
		const o = parseGradient({ code })[0]?.orientation;
		if (!o || Array.isArray(o) || o.type !== "angular") return 180;
		const v = o.value;
		return v.endsWith("rad")
			? (Number.parseFloat(v) * 180) / Math.PI
			: Number.parseFloat(v);
	};
	const ctx2d = (canvas: Canvas) =>
		canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
	const canvas = createCanvas(64, 64);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#000000";
	drawCssBackground({
		ctx: ctx2d(canvas),
		width: 64,
		height: 64,
		css: "linear-gradient(180deg, hsl(0, 100%, 50%), blue)",
	});
	expect(
		Math.abs(
			toDeg("linear-gradient(1.5707963rad, red, blue)") -
				toDeg("linear-gradient(90deg, red, blue)"),
		),
	).toBeLessThan(0.001);
	const rgb = parseGradient({ code: "linear-gradient(red, rgb(255 0 0 / 0.5))" })[0]
		?.colorStops[1];
	expect(rgb?.type === "rgba" && rgb.value).toEqual(["255", "0", "0", "0.5"]);
	const hsl = parseGradient({
		code: "linear-gradient(red, hsl(240 100% 50% / 50%))",
	})[0]?.colorStops[1];
	expect(hsl?.type === "hsla" && hsl.value[3]).toBe("0.5");
	const invalid = createCanvas(32, 32);
	const bad = invalid.getContext("2d");
	bad.fillStyle = "#000000";
	drawCssBackground({
		ctx: ctx2d(invalid),
		width: 32,
		height: 32,
		css: "conic-gradient(from 0deg, red, blue)",
	});
	expect(bad.fillStyle).toBe("rgba(0,0,0,0)");
});