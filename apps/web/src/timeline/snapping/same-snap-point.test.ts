import { expect, test } from "bun:test";
import { sameSnapPoint } from "./resolve";
import { mediaTime } from "@/wasm";

test("snap points are the same by value", () => {
	const point = { time: mediaTime({ ticks: 4000 }), type: "element-start" as const, elementId: "a", trackId: "t" };
	expect(sameSnapPoint({ a: point, b: { ...point } })).toBe(true);
	expect(sameSnapPoint({ a: null, b: null })).toBe(true);
	expect(sameSnapPoint({ a: point, b: null })).toBe(false);
	expect(sameSnapPoint({ a: point, b: { ...point, elementId: "b" } })).toBe(false);
	expect(sameSnapPoint({ a: point, b: { ...point, time: mediaTime({ ticks: 4001 }) } })).toBe(false);
});
