import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { usePropertyDraft } from "@/components/editor/panels/properties/hooks/use-property-draft";
import { NumberField } from "@/components/ui/number-field";

let dom: Window;
let root: Root;
let restoreGlobals: () => void;

beforeEach(async () => {
	dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		navigator: dom.navigator,
		HTMLElement: dom.HTMLElement,
		HTMLInputElement: dom.HTMLInputElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const originals = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as unknown as HTMLElement);
});

afterEach(async () => {
	await act(async () => root.unmount());
	await dom.close();
	restoreGlobals();
});

async function typeInto(value: string, key: "Escape" | "Enter") {
	const committed: number[] = [];
	let discarded = 0;
	const Harness = () => {
		const draft = usePropertyDraft({
			displayValue: "1",
			parse: (input) => {
				const n = Number(input);
				return Number.isFinite(n) ? n : null;
			},
			onPreview: () => {},
			onCommit: (next) => { committed.push(next); },
			onInvalid: () => { discarded++; },
		});
		return (
			<NumberField
				aria-label="Speed"
				value={draft.displayValue}
				onFocus={draft.onFocus}
				onChange={draft.onChange}
				onBlur={draft.onBlur}
				onKeyDown={draft.onKeyDown}
			/>
		);
	};
	await act(async () => {
		root.render(<Harness />);
	});
	const input = dom.document.querySelector("input[aria-label=Speed]") as unknown as HTMLInputElement;
	await act(async () => {
		input.focus();
		Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
		input.dispatchEvent(new dom.KeyboardEvent("keydown", { key, bubbles: true }) as unknown as Event);
	});
	return { committed, discarded, focused: dom.document.activeElement === (input as unknown) };
}

test("Escape in a number field drops the typed value and its preview", async () => {
	expect(await typeInto("2", "Escape")).toEqual({ committed: [], discarded: 1, focused: false });
});

test("Enter in a number field still commits the typed value", async () => {
	expect(await typeInto("2", "Enter")).toEqual({ committed: [2], discarded: 0, focused: false });
});
