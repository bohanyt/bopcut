import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { LoadBoundary } from "./load-boundary";

let dom: Window;
let root: Root;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(async () => {
	dom = new Window();
	for (const [key, value] of Object.entries({ window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, value });
	}
	root = (await import("react-dom/client")).createRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(async () => {
	act(() => root.unmount());
	await dom.close();
	for (const [key, original] of originals) {
		if (original) Object.defineProperty(globalThis, key, original);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

function ThrowingChild(): never {
	throw new Error("chunk failed");
}

function OkChild({ label }: { label: string }) {
	return <span data-testid="ok">{label}</span>;
}

function render(children: ReactNode) {
	act(() => root.render(children));
}

test("shows fallback message and reload button when a child throws", () => {
	const muteError = console.error;
	console.error = () => {};
	try {
		render(<LoadBoundary><ThrowingChild /></LoadBoundary>);
		expect(document.body.textContent).toContain(
			"This part could not be loaded. The editor may have been updated.",
		);
		expect(document.body.querySelector("button")?.textContent).toContain("Reload");
	} finally {
		console.error = muteError;
	}
});

test("renders children unchanged when they do not throw", () => {
	render(<LoadBoundary><OkChild label="safe" /></LoadBoundary>);
	expect(document.body.querySelector("[data-testid='ok']")?.textContent).toBe("safe");
});

test("changing the key shows a child that no longer throws", () => {
	const muteError = console.error;
	console.error = () => {};
	try {
		render(<LoadBoundary key="broken"><ThrowingChild /></LoadBoundary>);
		render(<LoadBoundary key="fixed"><OkChild label="recovered" /></LoadBoundary>);
		expect(document.body.querySelector("[data-testid='ok']")?.textContent).toBe("recovered");
	} finally {
		console.error = muteError;
	}
});
