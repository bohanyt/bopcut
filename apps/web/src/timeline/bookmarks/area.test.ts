import { expect, test } from "bun:test";
import { areaKeyAction, boxBetween, normalizeBookmarkBox, picturePoint } from "./area";

test("uses the displayed picture rather than the surrounding viewport at every zoom and orientation", () => {
	const expected = { x: 0.25, y: 0.5 };
	for (const rect of [
		{ left: 120, top: 80, width: 640, height: 360 },
		{ left: -450, top: -190, width: 1280, height: 720 },
		{ left: 370, top: 16, width: 180, height: 320 },
	]) {
		expect(picturePoint({ x: rect.left + rect.width / 4, y: rect.top + rect.height / 2 }, rect)).toEqual(expected);
	}
});

test("blocks timeline keys, preserves text input and reserves Escape and Enter for the area editor", () => {
	for (const key of [" ", "Delete", "Backspace", "s", "q", "w", "d", "z"]) {
		expect(areaKeyAction(key, false, false, key === "d" || key === "z")).toBe("block");
		expect(areaKeyAction(key, true, false, false)).toBe("native");
	}
	expect(areaKeyAction("Escape", true, false, false)).toBe("cancel");
	expect(areaKeyAction("Enter", true, false, false)).toBe("confirm");
	expect(areaKeyAction("ArrowLeft", false, true, false)).toBe("resize");
	expect(areaKeyAction("Tab", false, false, false)).toBe("native");
});

test("clamps a reversed drag, keeps valid saved fractions, and rejects corrupt boxes", () => {
	expect(boxBetween({ x: 2, y: 2 }, { x: 0.25, y: -1 })).toEqual({ x: 0.25, y: 0, width: 0.75, height: 1 });
	expect(boxBetween({ x: 1, y: 1 }, { x: 1, y: 1 })).toEqual({ x: 0.99, y: 0.99, width: 0.01, height: 0.01 });
	const saved = { x: 0.1, y: 0.2, width: 0.2, height: 0.25 };
	expect(normalizeBookmarkBox(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
	expect(normalizeBookmarkBox({ ...saved, height: Infinity })).toBeUndefined();
});
