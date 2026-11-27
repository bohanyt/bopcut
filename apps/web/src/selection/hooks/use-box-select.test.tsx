import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useRef } from "react";
import { useBoxSelect } from "./use-box-select";

test("a box drag keeps one set of window listeners and still selects what it crosses", async () => {
	const dom = new Window();
	const globals = { window: dom, document: dom.document, requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), IS_REACT_ACT_ENVIRONMENT: true };
	const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
	const added = spyOn(dom, "addEventListener");
	const selections: string[][] = [];
	function Box() {
		const containerRef = useRef<HTMLDivElement>(null);
		const { handleMouseDown, isSelecting } = useBoxSelect<string>({
			containerRef,
			selectedIds: [],
			anchorId: null,
			// Every 10 px to the right crosses one more item.
			resolveIntersections: ({ startPos, currentPos }) =>
				Array.from({ length: Math.floor(Math.abs(currentPos.x - startPos.x) / 10) }, (_, index) => `item-${index}`),
			onSelectionChange: ({ intersectedIds }) => selections.push(intersectedIds),
		});
		return <div ref={containerRef} data-selecting={String(isSelecting)} onMouseDown={handleMouseDown} />;
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(dom.document.body as never);
	try {
		act(() => root.render(<Box />));
		const box = dom.document.querySelector("div")!;
		act(() => { box.dispatchEvent(new dom.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 0, clientY: 0 })); });
		const moves = () => added.mock.calls.filter(([type]) => type === "mousemove").length;
		const attached = moves();
		for (const clientX of [8, 16, 24, 32, 41]) {
			act(() => { dom.dispatchEvent(new dom.MouseEvent("mousemove", { clientX, clientY: 0 })); });
		}
		expect(moves()).toBe(attached);
		expect(box.getAttribute("data-selecting")).toBe("true");
		expect(dom.document.body.style.userSelect).toBe("none");
		expect(selections.at(-1)).toEqual(["item-0", "item-1", "item-2", "item-3"]);
		act(() => { dom.dispatchEvent(new dom.MouseEvent("mouseup")); });
		expect(box.getAttribute("data-selecting")).toBe("false");
		expect(dom.document.body.style.userSelect).toBe("");
	} finally {
		act(() => root.unmount());
		added.mockRestore();
		for (const [key, value] of previous) {
			if (value) Object.defineProperty(globalThis, key, value);
			else Reflect.deleteProperty(globalThis, key);
		}
		await dom.close();
	}
});
