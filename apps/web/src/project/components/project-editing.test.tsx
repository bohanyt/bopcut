import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { bindAction, unbindAction } from "@/actions";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { EditableTimecode } from "@/components/editable-timecode";
import { EditableProjectName } from "@/components/editor/editor-header";
import { Dialog } from "@/components/ui/dialog";
import { EditorCore } from "@/core";
import { mediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { DeleteProjectConfirmation } from "./delete-project-dialog";

let dom: Window;
let root: Root;
let restoreGlobals: () => void;

beforeEach(async () => {
	dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		Node: dom.Node,
		HTMLElement: dom.HTMLElement,
		HTMLInputElement: dom.HTMLInputElement,
		requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const originals = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value,
		});
	}
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	const { createRoot } = await import("react-dom/client");
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	try {
		act(() => root.unmount());
		await dom.close();
	} finally {
		restoreGlobals();
	}
});

function render(children: ReactNode) {
	act(() => root.render(children));
}

function pressKey(element: HTMLElement, key: string) {
	act(() => {
		element.dispatchEvent(
			new window.KeyboardEvent("keydown", {
				key,
				bubbles: true,
				cancelable: true,
			}),
		);
	});
}

function typeValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("Expected the native input value setter");
	act(() => {
		setter.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}

test.each([
	{ flow: "single", names: ["First"] },
	{ flow: "bulk", names: ["First", "Second"] },
])("requires a fresh confirmation keyword for $flow deletion", ({ names }) => {
	const onConfirm = mock(() => {});
	const dialog = (isOpen: boolean) => (
		<Dialog>
			<DeleteProjectConfirmation
				isOpen={isOpen}
				projectNames={names}
				onConfirm={onConfirm}
				onCancel={() => {}}
			/>
		</Dialog>
	);
	render(dialog(true));

	const getInput = () => document.querySelector("input")!;
	const getDeleteButton = () =>
		[...document.querySelectorAll("button")].find(
			(button) => button.textContent === "Delete project",
		)!;

	const input = getInput();
	const deleteButton = getDeleteButton();
	for (const value of ["", "delete", "DELETE "]) {
		typeValue(input, value);
		expect(deleteButton.disabled).toBe(true);
		act(() => deleteButton.click());
		expect(onConfirm).not.toHaveBeenCalled();
	}

	typeValue(input, "DELETE");
	expect(deleteButton.disabled).toBe(false);
	act(() => deleteButton.click());
	expect(onConfirm).toHaveBeenCalledTimes(1);

	render(dialog(false));
	render(dialog(true));
	expect(getInput().value).toBe("");
	expect(getDeleteButton().disabled).toBe(true);
});

function EditorShortcuts({ children }: { children: ReactNode }) {
	useKeybindingsListener();
	return <>{children}</>;
}

test.each([
	{ finish: "Escape", expected: false },
	{ finish: "Enter", expected: true },
	{ finish: "click away", expected: true },
])("finishes an inline rename with $finish", ({ finish, expected }) => {
	const project = EditorCore.getInstance().project;
	const date = new Date(0);
	const getActive = spyOn(project, "getActive").mockReturnValue({
		metadata: {
			id: "project",
			name: " Original ",
			duration: ZERO_MEDIA_TIME,
			createdAt: date,
			updatedAt: date,
		},
		scenes: [],
		currentSceneId: "scene",
		version: 1,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
	});
	const rename = spyOn(project, "renameProject").mockResolvedValue(undefined);
	try {
		render(
			<EditorShortcuts>
				<EditableProjectName />
				<button type="button">Outside</button>
			</EditorShortcuts>,
		);
		const input = document.querySelector("input")!;
		act(() => {
			input.focus();
			input.click();
		});
		typeValue(input, " New title ");

		if (finish === "click away") {
			act(() => document.querySelector("button")!.focus());
		} else {
			pressKey(input, finish);
		}

		expect(input.readOnly).toBe(true);
		if (expected) {
			expect(rename.mock.calls).toEqual([
				[{ id: "project", name: "New title" }],
			]);
		} else {
			expect(input.value).toBe(" Original ");
			expect(rename).not.toHaveBeenCalled();
		}
	} finally {
		getActive.mockRestore();
		rename.mockRestore();
	}
});

test("Escape cancels a valid timecode draft without seeking", () => {
	const seek = mock(() => {});
	render(
		<EditorShortcuts>
			<EditableTimecode
				time={ZERO_MEDIA_TIME}
				duration={mediaTime({ ticks: 1_200_000 })}
				fps={{ numerator: 30, denominator: 1 }}
				onTimeChange={seek}
			/>
		</EditorShortcuts>,
	);
	act(() => document.querySelector("button")!.click());
	const input = document.querySelector("input")!;
	typeValue(input, "00:00:01:00");
	pressKey(input, "Escape");

	expect(seek).not.toHaveBeenCalled();
	expect(document.querySelector("button")?.textContent).toBe("00:00:00:00");
});

test("Escape still blurs an ordinary field and runs its shortcut outside the field", () => {
	const cancel = mock(() => {});
	bindAction("cancel-interaction", cancel);
	try {
		render(
			<EditorShortcuts>
				<input />
			</EditorShortcuts>,
		);
		const input = document.querySelector("input")!;
		act(() => input.focus());
		pressKey(input, "Escape");
		expect(document.activeElement).not.toBe(input);
		expect(cancel).not.toHaveBeenCalled();

		pressKey(document.body, "Escape");
		expect(cancel).toHaveBeenCalledTimes(1);
	} finally {
		unbindAction("cancel-interaction", cancel);
	}
});
