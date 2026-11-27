import { expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { SelectionManager } from "./selection-manager";

function manager() {
	const selection = new SelectionManager({} as EditorCore);
	let notified = 0;
	selection.subscribe(() => { notified++; });
	return { selection, notified: () => notified };
}

const key = (keyframeId: string) => ({ trackId: "t", elementId: "e", propertyPath: "opacity" as never, keyframeId });

test("setting the same elements again wakes no listener", () => {
	const { selection, notified } = manager();
	selection.setSelectedElements({ elements: [{ trackId: "t", elementId: "a" }] });
	selection.setSelectedElements({ elements: [{ trackId: "t", elementId: "a" }] });
	expect(notified()).toBe(1);
	selection.setSelectedElements({ elements: [{ trackId: "t", elementId: "b" }] });
	expect(notified()).toBe(2);
	// Elements replace a keyframe selection even when they are the same ones.
	selection.setSelectedKeyframes({ keyframes: [key("k")] });
	selection.setSelectedElements({ elements: [{ trackId: "t", elementId: "b" }] });
	expect(notified()).toBe(4);
	expect(selection.getSelectedKeyframes()).toEqual([]);
});

test("setting the same keyframes and anchor again wakes no listener", () => {
	const { selection, notified } = manager();
	selection.setSelectedKeyframes({ keyframes: [key("a"), key("b")], anchorKeyframe: key("a") });
	selection.setSelectedKeyframes({ keyframes: [key("a"), key("b")] });
	selection.setSelectedKeyframes({ keyframes: [key("a"), key("b")], anchorKeyframe: key("a") });
	expect(notified()).toBe(1);
	selection.setSelectedKeyframes({ keyframes: [key("a"), key("b")], anchorKeyframe: key("b") });
	expect(notified()).toBe(2);
	selection.setSelectedKeyframes({ keyframes: [key("a")] });
	expect(notified()).toBe(3);
	selection.setSelectedKeyframes({ keyframes: [] });
	expect(selection.getSnapshot().keyframeSelectionAnchor).toBeNull();
	expect(notified()).toBe(4);
});
