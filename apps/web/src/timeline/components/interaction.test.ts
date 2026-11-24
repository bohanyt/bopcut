import { expect, test } from "bun:test";
import { getWheelScroll } from "./interaction";

const wheel = { deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false, altKey: false };

test("Alt turns the wheel sideways, other wheel gestures stay as they are", () => {
	expect(getWheelScroll(wheel)).toEqual({ axis: "y", delta: 100 });
	expect(getWheelScroll({ ...wheel, altKey: true })).toEqual({ axis: "x", delta: 100 });
	expect(getWheelScroll({ ...wheel, altKey: true, deltaY: -100 })).toEqual({ axis: "x", delta: -100 });
	expect(getWheelScroll({ ...wheel, altKey: true, deltaY: 3, deltaMode: 1 })).toEqual({ axis: "x", delta: 48 });
	expect(getWheelScroll({ ...wheel, altKey: true, deltaX: 60, deltaY: 5 })).toEqual({ axis: "x", delta: 60 });
	expect(getWheelScroll({ ...wheel, shiftKey: true })).toEqual({ axis: "x", delta: 40 });
	expect(getWheelScroll({ ...wheel, shiftKey: true, deltaY: -10 })).toEqual({ axis: "x", delta: -10 });
	expect(getWheelScroll({ ...wheel, deltaX: 80, deltaY: 5 })).toEqual({ axis: "x", delta: 40 });
});
