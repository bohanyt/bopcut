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

test("gradient color forms: percent channels, percent alpha, hue units", () => {
	const lastStop = (code: string) => parseGradient({ code })[0]?.colorStops.at(-1);
	type ExpectOk = { type: "rgb" | "rgba" | "hsl" | "hsla"; value: string[] };
	type Row = { code: string; expect: ExpectOk | { fail: true }; legacy?: boolean };
	const cases: Row[] = [
		{ legacy: true, code: "linear-gradient(red, rgb(255, 0, 0))", expect: { type: "rgb", value: ["255", "0", "0"] } },
		{ legacy: true, code: "linear-gradient(red, rgb(255,0,0))", expect: { type: "rgb", value: ["255", "0", "0"] } },
		{ legacy: true, code: "linear-gradient(red, RGB(255, 0, 0))", expect: { type: "rgb", value: ["255", "0", "0"] } },
		{ legacy: true, code: "linear-gradient(red, rgb(255, 0, 0, 0.5))", expect: { type: "rgb", value: ["255", "0", "0", "0.5"] } },
		{ legacy: true, code: "linear-gradient(red, rgba(255, 0, 0))", expect: { type: "rgba", value: ["255", "0", "0"] } },
		{ legacy: true, code: "linear-gradient(red, rgba(255, 0, 0, 0.5))", expect: { type: "rgba", value: ["255", "0", "0", "0.5"] } },
		{ legacy: true, code: "linear-gradient(red, rgb(255 0 0))", expect: { type: "rgb", value: ["255", "0", "0"] } },
		{ legacy: true, code: "linear-gradient(red, rgb(255 0 0 / 0.5))", expect: { type: "rgba", value: ["255", "0", "0", "0.5"] } },
		{ legacy: true, code: "linear-gradient(red, hsl(90, 50%, 50%))", expect: { type: "hsl", value: ["90", "50", "50"] } },
		{ legacy: true, code: "linear-gradient(red, hsla(90, 50%, 50%, 0.5))", expect: { type: "hsla", value: ["90", "50", "50", "0.5"] } },
		{ code: "linear-gradient(red, rgb(100%, 0%, 0%))", expect: { type: "rgb", value: ["255", "0", "0"] } },
		{ code: "linear-gradient(red, rgb(50%, 0%, 100%))", expect: { type: "rgb", value: ["128", "0", "255"] } },
		{ code: "linear-gradient(red, rgb(0%,50%,0%))", expect: { type: "rgb", value: ["0", "128", "0"] } },
		{ code: "linear-gradient(red, rgba(255, 0, 0, 50%))", expect: { type: "rgba", value: ["255", "0", "0", "0.5"] } },
		{ code: "linear-gradient(red, rgba(100%, 0%, 0%, 25%))", expect: { type: "rgba", value: ["255", "0", "0", "0.25"] } },
		{ code: "linear-gradient(red, rgb(255, 0, 0, 75%))", expect: { type: "rgb", value: ["255", "0", "0", "0.75"] } },
		{ code: "linear-gradient(red, rgba(255,0,0,100%))", expect: { type: "rgba", value: ["255", "0", "0", "1"] } },
		{ code: "linear-gradient(red, rgb(50% 0% 100%))", expect: { type: "rgb", value: ["128", "0", "255"] } },
		{ code: "linear-gradient(red, rgb(100% 0% 0% / 50%))", expect: { type: "rgba", value: ["255", "0", "0", "0.5"] } },
		{ code: "linear-gradient(red, RGBA(100%,0%,0%,50%))", expect: { type: "rgba", value: ["255", "0", "0", "0.5"] } },
		{ code: "linear-gradient(red, hsl(90deg, 50%, 50%))", expect: { type: "hsl", value: ["90", "50", "50"] } },
		{ code: "linear-gradient(red, hsl(1.5707963rad, 50%, 50%))", expect: { type: "hsl", value: ["90", "50", "50"] } },
		{ code: "linear-gradient(red, hsl(0.25turn, 50%, 50%))", expect: { type: "hsl", value: ["90", "50", "50"] } },
		{ code: "linear-gradient(red, hsl(100grad, 50%, 50%))", expect: { type: "hsl", value: ["90", "50", "50"] } },
		{ code: "linear-gradient(red, hsl(-90deg, 50%, 50%))", expect: { type: "hsl", value: ["-90", "50", "50"] } },
		{ code: "linear-gradient(red, hsl(240deg 100% 50%))", expect: { type: "hsl", value: ["240", "100", "50"] } },
		{ code: "linear-gradient(red, hsl(90rad 50% 50%))", expect: { type: "hsl", value: ["5156.6202", "50", "50"] } },
		{ code: "linear-gradient(red, hsla(90deg, 50%, 50%, 50%))", expect: { type: "hsla", value: ["90", "50", "50", "0.5"] } },
		{ code: "linear-gradient(red, hsl(0.25turn 100% 50% / 25%))", expect: { type: "hsla", value: ["90", "100", "50", "0.25"] } },
		{ code: "linear-gradient(red, rgb(100%, 0% 0%))", expect: { fail: true } },
		{ code: "linear-gradient(red, rgb(255, 0))", expect: { fail: true } },
		{ code: "linear-gradient(red, rgb(1, 2, 3, 4, 5))", expect: { fail: true } },
		{ code: "linear-gradient(red, hsl(90pt, 50%, 50%))", expect: { fail: true } },
		{ code: "linear-gradient(red, rgb(255 0))", expect: { fail: true } },
		{ code: "linear-gradient(red, hsl(50%, 50%, 50%))", expect: { fail: true } },
	];
	for (const { code, expect: expected } of cases) {
		if ("fail" in expected) {
			expect(() => parseGradient({ code })).toThrow();
			continue;
		}
		const stop = lastStop(code);
		expect(stop?.type).toBe(expected.type);
		if (stop && "value" in stop) expect(stop.value).toEqual(expected.value);
	}
	const mixed = parseGradient({ code: "linear-gradient(rgb(255,0,0), hsl(90deg,50%,50%), rgb(100%,0%,0%), blue)" })[0]?.colorStops;
	expect(mixed?.map((s) => s.type)).toEqual(["rgb", "hsl", "rgb", "literal"]);
	expect(mixed?.[2]).toMatchObject({ type: "rgb", value: ["255", "0", "0"] });
});