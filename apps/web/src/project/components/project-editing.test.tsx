import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { bindAction, unbindAction } from "@/actions";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { EditableTimecode } from "@/components/editable-timecode";
import { EditableProjectName } from "@/components/editor/editor-header";
import { useBackgroundColorPreview } from "@/components/editor/panels/assets/views/settings/background";
import { ColorPicker } from "@/components/ui/color-picker";
import { Dialog } from "@/components/ui/dialog";
import { EditorCore } from "@/core";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { mediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
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
	{ mode: "editing", finish: "Escape", expected: false },
	{ mode: "editing", finish: "Enter", expected: true },
	{ mode: "editing", finish: "click away", expected: true },
	{ mode: "read-only", finish: "Escape", expected: false },
])("$finish on the $mode title", ({ mode, finish, expected }) => {
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
			if (mode === "editing") input.click();
		});
		if (mode === "editing") typeValue(input, " New title ");

		if (finish === "click away") {
			act(() => document.querySelector("button")!.focus());
		} else {
			pressKey(input, finish);
		}

		expect(input.readOnly).toBe(true);
		expect(document.activeElement).not.toBe(input);
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

test("a corrected timecode commits on blur after an invalid Enter", () => {
	const seek = mock<(value: { time: MediaTime }) => void>(() => {});
	render(
		<EditorShortcuts>
			<EditableTimecode
				time={ZERO_MEDIA_TIME}
				duration={mediaTime({ ticks: 1_200_000 })}
				fps={{ numerator: 30, denominator: 1 }}
				onTimeChange={seek}
			/>
			<button type="button">Outside</button>
		</EditorShortcuts>,
	);
	const [timecode, outside] = document.querySelectorAll("button");
	act(() => timecode.click());
	const input = document.querySelector("input")!;
	typeValue(input, "invalid");
	pressKey(input, "Enter");
	expect(document.activeElement).toBe(input);
	expect(seek).not.toHaveBeenCalled();

	typeValue(input, "00:00:01:00");
	act(() => outside.focus());

	expect(seek.mock.calls).toEqual([[{ time: mediaTime({ ticks: 120_000 }) }]]);
	expect(document.querySelector("input")).toBeNull();
});

function CustomBackgroundField({ value }: { value: string }) {
	const { previewColor, commitColor } = useBackgroundColorPreview();
	return (
		<ColorPicker
			value={value.replace(/^#/, "").toUpperCase()}
			onChange={previewColor}
			onChangeEnd={commitColor}
		/>
	);
}

test.each([
	{ finish: "blur", original: { type: "color", color: "#123456" } as const },
	{ finish: "Enter", original: { type: "blur", blurIntensity: 12 } as const },
])("a custom background committed by $finish can be undone and redone", ({ finish, original }) => {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	const date = new Date(0);
	editor.project.setActiveProject({
		project: {
			metadata: {
				id: "project",
				name: "Background test",
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
				background: original,
			},
		},
	});
	try {
		render(
			<CustomBackgroundField
				value={original.type === "color" ? original.color : DEFAULT_BACKGROUND_COLOR}
			/>,
		);
		const input = document.querySelector("input")!;
		act(() => input.focus());
		typeValue(input, "abcdef");
		if (finish === "Enter") pressKey(input, "Enter");
		else act(() => input.blur());

		const getBackground = () => editor.project.getActive().settings.background;
		const edited = { type: "color", color: "#abcdef" } as const;
		expect(getBackground()).toEqual(edited);
		act(() => editor.command.undo());
		expect(getBackground()).toEqual(original);
		expect(editor.command.canUndo()).toBe(false);
		act(() => editor.command.redo());
		expect(getBackground()).toEqual(edited);
	} finally {
		EditorCore.reset();
	}
});

test("Enter commits an inline color once", () => {
	const onChangeEnd = mock<(color: string) => void>(() => {});
	render(<ColorPicker value="123456" onChangeEnd={onChangeEnd} />);
	const input = document.querySelector("input")!;
	act(() => input.focus());
	typeValue(input, "abcdef");
	pressKey(input, "Enter");
	expect(onChangeEnd.mock.calls).toEqual([["abcdef"]]);
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
