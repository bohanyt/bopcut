import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef } from "react";
import { EditorCore } from "@/core";
import { fixture, getHost, t, video } from "@/timeline/__tests__/compound-fixtures";
import type { ElementInteractionController } from "@/timeline/controllers/element-interaction-controller";
import { useElementDragView, useElementInteraction } from "./use-element-interaction";

let dom: Window;
let restore: Array<() => void> = [];
beforeEach(() => {
	dom = new Window();
	const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
	for (const [key, value] of Object.entries(globals)) {
		const previous = Object.getOwnPropertyDescriptor(globalThis, key);
		Object.defineProperty(globalThis, key, { configurable: true, value });
		restore.push(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
	}
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks.overlay = [];
	host.tracks.audio = [];
	host.tracks.main.elements = [video("a", 0, 2), video("b", 3, 2)];
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "Project", duration: t(5), createdAt: new Date(0), updatedAt: new Date(0) },
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } },
		currentSceneId: "main", scenes, version: 1,
	} });
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
});
afterEach(async () => {
	EditorCore.reset();
	await dom.close();
	for (const undo of restore.splice(0).reverse()) undo();
});

const renders = { owner: 0, drag: 0 };
function DragPart({ controller }: { controller: ElementInteractionController }) {
	renders.drag++;
	const view = useElementDragView(controller);
	return <span data-time={view.kind === "dragging" ? String(view.currentTime) : ""} />;
}
function Owner() {
	renders.owner++;
	const tracksRef = useRef<HTMLDivElement>(null);
	const { controller, isElementDragging, handleElementMouseDown } = useElementInteraction({
		zoomLevel: 10, tracksContainerRef: tracksRef, tracksScrollRef: tracksRef, snappingEnabled: false,
	});
	const track = EditorCore.getInstance().scenes.getActiveScene().tracks.main;
	return (
		<div ref={tracksRef} data-dragging={String(isElementDragging)}>
			<button type="button" onMouseDown={(event) => handleElementMouseDown({ event, element: track.elements[0], track })} />
			<DragPart controller={controller} />
		</div>
	);
}

test("moving a clip re-renders only what draws the drag, and that only when the drawn frame changes", async () => {
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(dom.document.body as never);
	act(() => root.render(<Owner />));
	const move = (clientX: number) => act(() => { dom.document.dispatchEvent(new dom.MouseEvent("mousemove", { clientX, clientY: 10 })); });
	act(() => { dom.document.querySelector("button")!.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 })); });
	// At 500 px a second a frame is about 16.7 px.
	move(60);
	expect(dom.document.querySelector("div")!.getAttribute("data-dragging")).toBe("true");
	const owner = renders.owner;
	const drag = renders.drag;
	for (const clientX of [60.5, 61, 61.5, 60]) move(clientX);
	expect(renders.drag).toBe(drag);
	move(110);
	move(160);
	expect(renders.owner).toBe(owner);
	expect(renders.drag).toBe(drag + 2);
	act(() => { dom.document.dispatchEvent(new dom.MouseEvent("mouseup", { button: 0, clientX: 160, clientY: 10 })); });
	expect(dom.document.querySelector("div")!.getAttribute("data-dragging")).toBe("false");
	expect(renders.owner).toBe(owner + 1);
	act(() => root.unmount());
});
