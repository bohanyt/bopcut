import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { bindAction, unbindAction } from "@/actions";
import { toast } from "sonner";
import { AnimationTab } from "@/animation/components/animation-tab";
import { applyAnimationPresets, readPresetSettings } from "@/animation/presets";
import { PreviewFramingProvider, usePreviewViewportState } from "@/preview/components/preview-viewport";
import { fixture, scene, t, video } from "@/timeline/__tests__/compound-fixtures";
import { SpeedTab } from "@/speed/components/speed-tab";
import { useKeybindingsListener } from "@/actions/use-keybindings";
import { EditableTimecode } from "@/components/editable-timecode";
import { EditableProjectName } from "@/components/editor/editor-header";
import { useBackgroundColorPreview } from "@/components/editor/panels/assets/views/settings/background";
import { ColorPicker } from "@/components/ui/color-picker";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { PopoverContent } from "@/components/ui/popover";
import { CompoundTab } from "@/components/editor/panels/properties/components/compound-tab";
import { ElementParamsTab } from "@/components/editor/panels/properties/components/element-params-tab";
import { SettingsView } from "@/components/editor/panels/assets/views/settings";
import { TimelineBookmarksRow } from "@/timeline/bookmarks/components/bookmarks";
import { EditorCore } from "@/core";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { mediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { DeleteProjectConfirmation } from "./delete-project-dialog";
import { RenameProjectDialog } from "./rename-project-dialog";

let dom: Window;
let root: Root;
let restoreGlobals: () => void;

beforeEach(async () => {
	dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		Node: dom.Node,
		Element: dom.Element,
		HTMLElement: dom.HTMLElement,
		HTMLInputElement: dom.HTMLInputElement,
		getComputedStyle: dom.getComputedStyle.bind(dom),
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

function pressKey(element: HTMLElement, key: string, isComposing = false) {
	act(() => {
		element.dispatchEvent(
			new window.KeyboardEvent("keydown", {
				key,
				bubbles: true,
				cancelable: true,
				isComposing,
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
	{ mode: "editing", finish: "IME Enter", expected: true },
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
		} else if (finish === "IME Enter") {
			pressKey(input, "Enter", true);
			expect(rename).not.toHaveBeenCalled();
			expect(input.readOnly).toBe(false);
			expect(document.activeElement).toBe(input);
			pressKey(input, "Enter");
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

test("confirming an IME composition leaves the timecode open", () => {
	const seek = mock(() => {});
	render(<EditableTimecode time={t(0)} duration={t(10)}
		fps={{ numerator: 30, denominator: 1 }} onTimeChange={seek} />);
	act(() => document.querySelector("button")!.click());
	const input = document.querySelector("input")!;
	typeValue(input, "00:00:02:00");
	pressKey(input, "Enter", true);
	expect(seek).not.toHaveBeenCalled();
	expect(document.activeElement).toBe(input);
	pressKey(input, "Enter");
	expect(seek).toHaveBeenCalledTimes(1);
});

test("confirming an IME composition keeps the rename dialog draft", () => {
	const inlineDialog = spyOn(DialogContent as unknown as {
		render: (props: React.ComponentProps<typeof DialogContent>) => ReactNode;
	}, "render").mockImplementation(({ children }) => <div>{children}</div>);
	const confirm = mock<(name: string) => void>(() => {});
	try {
		render(<RenameProjectDialog isOpen projectName="Old title" onConfirm={confirm} onOpenChange={() => {}} />);
		const input = document.querySelector("input")!;
		act(() => input.focus());
		typeValue(input, "New title");
		pressKey(input, "Enter", true);
		expect(confirm).not.toHaveBeenCalled();
		expect(input.value).toBe("New title");
		pressKey(input, "Enter");
		expect(confirm.mock.calls).toEqual([["New title"]]);
	} finally {
		render(null);
		inlineDialog.mockRestore();
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

function setupEditingProject({ customCanvas = false } = {}) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	const scenes = fixture();
	const date = new Date(0);
	editor.scenes.initializeScenes({ scenes, currentSceneId: "main" });
	editor.project.setActiveProject({ project: {
		metadata: { id: "editing", name: "Editing", duration: t(10), createdAt: date, updatedAt: date },
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			canvasSizeMode: customCanvas ? "custom" : "preset",
			background: { type: "color", color: "#000000" },
		},
		currentSceneId: "main",
		timelineViewState: { zoomLevel: 2, scrollLeft: 23, playheadTime: t(1) },
		scenes,
		version: 1,
	} });
	return editor;
}

test.each([
	{ first: "2", final: "", expected: 1 },
	{ first: "2x", final: "2x+", expected: 1 },
	{ first: "1,5", final: "1,5", expected: 1.5 },
	{ first: "2x", final: "2x", expected: 2 },
	{ first: "1,5×", final: "1,5×", expected: 1.5 },
])("Speed commits $expected after editing $first", ({ first, final, expected }) => {
	const editor = setupEditingProject();
	editor.save.stop();
	const { tracks } = editor.scenes.getActiveScene();
	const element = tracks.main.elements[0];
	if (element.type !== "video") throw new Error("Expected a video");
	try {
		render(<SpeedTab element={element} trackId={tracks.main.id} />);
		const input = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
		act(() => input.focus());
		typeValue(input, first);
		if (final !== first) typeValue(input, final);
		pressKey(input, "Enter");
		const updated = editor.scenes.getActiveScene().tracks.main.elements[0];
		if (updated.type !== "video") throw new Error("Expected a video");
		expect(updated.retime?.rate ?? 1).toBe(expected);
		expect(editor.timeline.isPreviewActive()).toBe(false);
		expect(editor.command.canUndo()).toBe(expected !== 1);
		if (expected !== 1) {
			act(() => editor.command.undo());
			expect(editor.command.canUndo()).toBe(false);
		}
	} finally {
		render(null);
		EditorCore.reset();
	}
});

test("an invalid numeric property clears its earlier preview without saving it", () => {
	const editor = setupEditingProject();
	editor.save.stop();
	const { tracks } = editor.scenes.getActiveScene();
	const property = "transform.positionX";
	try {
		render(<ElementParamsTab element={tracks.main.elements[0]} trackId={tracks.main.id}
			sectionKey="position" paramKeys={[property]} />);
		const input = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
		act(() => input.focus());
		typeValue(input, "24");
		expect(editor.timeline.isPreviewActive()).toBe(true);
		typeValue(input, "24+");
		pressKey(input, "Enter");
		expect(input.value).toBe("0");
		expect(editor.timeline.isPreviewActive()).toBe(false);
		expect(editor.command.canUndo()).toBe(false);
	} finally {
		render(null);
		EditorCore.reset();
	}
});

test("a custom canvas width expression commits its final evaluated value", () => {
	const editor = setupEditingProject({ customCanvas: true });
	editor.save.stop();
	try {
		render(<SettingsView />);
		const input = document.querySelector<HTMLInputElement>('input[aria-label="Canvas width"]')!;
		act(() => input.focus());
		typeValue(input, "1280+160");
		pressKey(input, "Enter");
		expect(editor.project.getActive().settings.canvasSize.width).toBe(1440);
		act(() => editor.command.undo());
		expect(editor.project.getActive().settings.canvasSize.width).toBe(1920);
		expect(editor.command.canUndo()).toBe(false);
	} finally {
		render(null);
		EditorCore.reset();
	}
});

test.each([
	{ input: "00FF0040", expected: "00FF0040" },
	{ input: "0F0F", expected: "00FF00FF" },
	{ input: "0F0", expected: "00FF0080" },
])("inline color commits $input without changing its intended alpha", ({ input, expected }) => {
	const commit = mock<(color: string) => void>(() => {});
	render(<ColorPicker value="FF000080" onChangeEnd={commit} />);
	const field = document.querySelector("input")!;
	act(() => field.focus());
	typeValue(field, input);
	pressKey(field, "Enter");
	expect(commit.mock.calls).toEqual([[expected]]);
});

test("a legacy bookmark saves each keystroke without moving focus", () => {
	const editor = setupEditingProject();
	editor.save.stop();
	const inlinePopover = spyOn(PopoverContent as unknown as {
		render: (props: React.ComponentProps<typeof PopoverContent>) => ReactNode;
	}, "render").mockImplementation(({ children }) => <div>{children}</div>);
	try {
		const origin = editor.scenes.getActiveScene();
		editor.scenes.setScenes({ scenes: [{ ...origin, bookmarks: [{ time: t(1) }, { time: t(1) }] }] });
		const noop = () => {};
		render(<TimelineBookmarksRow zoomLevel={1} dynamicTimelineWidth={1000}
			dragState={{ isDragging: false, bookmark: null, currentTime: ZERO_MEDIA_TIME }} onBookmarkMouseDown={noop}
			handleWheel={noop} handleTimelineContentClick={noop}
			handleRulerTrackingPointerDown={noop} handleRulerPointerDown={noop} />);
		const marker = document.querySelector('button[aria-label^="Bookmark at"]')!;
		act(() => marker.dispatchEvent(new window.MouseEvent("click", { detail: 2, bubbles: true })));
		const selector = 'input[placeholder="Add a note..."]';
		const note = document.querySelector<HTMLInputElement>(selector)!;
		act(() => note.focus());
		typeValue(note, "H");
		expect(editor.scenes.getActiveScene().bookmarks[0].note).toBe("H");
		expect(editor.scenes.getActiveScene().bookmarks[0].id).toBeDefined();
		expect(document.activeElement).toBe(note);
		typeValue(note, "Hi");
		expect(document.querySelector(selector) === note).toBe(true);
		expect(editor.scenes.getActiveScene().bookmarks[0].note).toBe("Hi");
		const promoted = editor.scenes.getActiveScene().bookmarks[0];
		const errors = spyOn(console, "error");
		try {
			act(() => {
				void editor.scenes.moveBookmark({ bookmark: promoted, fromTime: t(1), toTime: t(3) });
			});
			expect(editor.scenes.getActiveScene().bookmarks.map(({ time }) => time)).toEqual([t(1), t(3)]);
			expect(errors.mock.calls.some(([message]) =>
				typeof message === "string" && message.includes("with the same key"),
			)).toBe(false);
		} finally {
			errors.mockRestore();
		}
		act(() => editor.command.undo());
		expect(editor.scenes.getActiveScene().bookmarks[0].note).toBe("Hi");
		act(() => editor.command.undo());
		expect(editor.scenes.getActiveScene().bookmarks[0].note).toBe("H");
		act(() => editor.command.undo());
		expect(editor.scenes.getActiveScene().bookmarks[0].note).toBeUndefined();
		expect(editor.command.canUndo()).toBe(false);
	} finally {
		render(null);
		inlinePopover.mockRestore();
		EditorCore.reset();
	}
});

test("confirming an IME composition keeps a compound name in its field", () => {
	const editor = setupEditingProject();
	editor.save.stop();
	const host = editor.scenes.getActiveScene();
	const nested = scene("compound", fixture()[0].tracks, { kind: "compound" });
	const element = { ...video("clip", 0, 10), type: "compound" as const, sceneId: nested.id, name: nested.name };
	editor.scenes.setScenes({ scenes: [host, nested] });
	try {
		render(<CompoundTab element={element} trackId={host.tracks.main.id} />);
		const input = document.querySelector("input")!;
		act(() => input.focus());
		typeValue(input, "New compound");
		pressKey(input, "Enter", true);
		expect(document.activeElement).toBe(input);
		expect(editor.scenes.getScenes()[1].name).toBe("compound");
		pressKey(input, "Enter");
		expect(editor.scenes.getScenes()[1].name).toBe("New compound");
	} finally {
		render(null);
		EditorCore.reset();
	}
});

test("animation preset length accepts a decimal comma and restores the value after invalid input", () => {
	const editor = setupEditingProject();
	editor.save.stop();
	const element = applyAnimationPresets(video("bg", 0, 10), { in: { type: "fade" } });
	const scene = editor.scenes.getActiveScene();
	editor.timeline.updateTracks({ ...scene.tracks, main: { ...scene.tracks.main, elements: [element] } });
	try {
		render(<AnimationTab element={element} trackId={scene.tracks.main.id} />);
		const input = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
		for (const [value, expected] of [["0.5x", 0.3], ["1,5", 1.5], ["1,5.2", 1.5]] as const) {
			act(() => input.focus());
			typeValue(input, value);
			pressKey(input, "Enter");
			const [updated] = editor.scenes.getActiveScene().tracks.main.elements;
			render(<AnimationTab element={updated} trackId={scene.tracks.main.id} />);
			expect(readPresetSettings(updated.params).in?.seconds).toBe(expected);
			expect(input.value).toBe(String(expected));
		}
	} finally {
		render(null);
		EditorCore.reset();
	}
});

test("the Speed tab reports an overlap once on commit and restores the speed", () => {
	const editor = setupEditingProject();
	editor.save.stop();
	editor.command.isRippleEnabled = false;
	const element = video("a", 0, 2);
	const { tracks } = editor.scenes.getActiveScene();
	editor.timeline.updateTracks({
		...tracks,
		main: { ...tracks.main, elements: [element, video("b", 2, 2)] },
	});
	const warn = spyOn(toast, "warning").mockReturnValue("overlap");
	try {
		render(<SpeedTab element={element} trackId={tracks.main.id} />);
		const input = document.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
		const previousValue = input.value;
		act(() => input.focus());
		typeValue(input, "0.75");
		typeValue(input, "0.5");
		expect(warn).not.toHaveBeenCalled();
		pressKey(input, "Enter");
		expect(warn.mock.calls).toEqual([["This speed would overlap the next clip. Enable Ripple or make room on the track."]]);
		expect(input.value).toBe(previousValue);
		expect(editor.command.canUndo()).toBe(false);
	} finally {
		render(null);
		EditorCore.reset();
		warn.mockRestore();
	}
});

const viewportRef = { current: null };

function ViewportSample({ width, height }: { width: number; height: number }) {
	const viewport = usePreviewViewportState({
		canvasWidth: 1000, canvasHeight: 1000, viewportWidth: width, viewportHeight: height, viewportRef,
	});
	return (
		<button
			data-scale={viewport.zoomPercent}
			data-center={(width / 2 - viewport.sceneLeft) / (viewport.sceneWidth / 1000)}
			onClick={() => viewport.isAtFit ? viewport.scaleZoom({ factor: 2 }) : viewport.panByScreenDelta({ deltaX: 140, deltaY: 0 })}
		/>
	);
}

test("changing preview parents preserves zoom and clamps the displayed center for each layout", () => {
	const layout = (right: boolean) => render(
		<PreviewFramingProvider canvasWidth={1000} canvasHeight={1000}>
			{right
				? <aside><ViewportSample width={600} height={400} /></aside>
				: <section><ViewportSample width={400} height={400} /></section>}
		</PreviewFramingProvider>,
	);
	const sample = () => document.querySelector("button")!;
	const framing = () => [Number(sample().dataset.scale), Number(sample().dataset.center)];
	layout(false);
	act(() => sample().click());
	act(() => sample().click());
	expect(framing()).toEqual([80, 675]);
	layout(true);
	expect(framing()).toEqual([80, 625]);
	layout(false);
	expect(framing()).toEqual([80, 675]);
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
