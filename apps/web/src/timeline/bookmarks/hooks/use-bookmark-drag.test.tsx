import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef } from "react";
import { EditorCore } from "@/core";
import { cancelInteraction } from "@/editor/cancel-interaction";
import { fixture, t } from "@/timeline/__tests__/compound-fixtures";
import { isTimelineGestureActive } from "@/timeline/gesture-state";
import { useBookmarkDrag } from "./use-bookmark-drag";

function BookmarkTest() {
	const scrollRef = useRef<HTMLDivElement>(null);
	const { handleBookmarkMouseDown } = useBookmarkDrag({ zoomLevel: 1, scrollRef, snappingEnabled: false });
	return (
		<div ref={scrollRef}>
			<button onMouseDown={(event) => handleBookmarkMouseDown({ event, bookmark: { time: t(0) } })}>Bookmark</button>
		</div>
	);
}

test("bookmark dragging releases the timeline gesture on drop, cancellation, and unmount", async () => {
	const editor = EditorCore.getInstance();
	editor.save.stop();
	editor.project.setActiveProject({ project: {
		metadata: { id: "project", name: "Project", duration: t(10), createdAt: new Date(), updatedAt: new Date() },
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" } },
		scenes: fixture(), currentSceneId: "main", version: 31,
	} });
	editor.scenes.setScenes({ scenes: fixture(), activeSceneId: "main" });
	const move = spyOn(editor.scenes, "moveBookmark").mockResolvedValue(undefined);
	const dom = new Window();
	const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
	const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.body);
	let unmounted = false;
	try {
		act(() => root.render(<BookmarkTest />));
		const start = () => {
			const button = dom.document.querySelector("button")!;
			act(() => { button.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, clientX: 10, button: 0 })); });
			act(() => { dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { clientX: 40 })); });
			expect(isTimelineGestureActive()).toBe(true);
		};
		start();
		act(() => { dom.document.dispatchEvent(new dom.MouseEvent("mouseup")); });
		expect(isTimelineGestureActive()).toBe(false);
		expect(move).toHaveBeenCalledTimes(1);
		start();
		act(() => { expect(cancelInteraction()).toBe(true); });
		expect(isTimelineGestureActive()).toBe(false);
		expect(move).toHaveBeenCalledTimes(1);
		start();
		act(() => root.unmount());
		unmounted = true;
		expect(isTimelineGestureActive()).toBe(false);
	} finally {
		if (!unmounted) act(() => root.unmount());
		for (const [key, value] of previous) {
			if (value) Object.defineProperty(globalThis, key, value);
			else Reflect.deleteProperty(globalThis, key);
		}
		move.mockRestore();
		EditorCore.reset();
	}
});
