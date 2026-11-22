import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TScene, TextElement } from "@/timeline";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import { buildEffectParamPath, getKeyframeAtTime } from "@/animation";
import { applyAnimationPresets, PRESET_PARAM } from "@/animation/presets";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { cancelInteraction } from "@/editor/cancel-interaction";
import { PreviewInteractionController } from "@/preview/controllers/preview-interaction-controller";
import { PreviewPointerCapture } from "@/preview/pointer-capture";
import { ElementInteractionController } from "@/timeline/controllers/element-interaction-controller";
import { startColorDrag } from "@/components/ui/color-drag";
import { appendAlpha, parseHexAlpha } from "@/utils/color";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { allElements, allTracks, fixture, getHost, refs, t, video } from "./compound-fixtures";

// Another test file replaces opencut-wasm with a partial mock and Bun keeps that module shape,
// so stub the GPU modules (unused here) before EditorCore pulls them in.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { BatchCommand } = await import("@/commands");
const { PasteKeyframesCommand } = await import("@/commands/timeline/clipboard");
const { RemoveMediaAssetCommand } = await import("@/commands/media");
const { applyDraft } = await import("@/agent/bridge");
const { CreateCompoundCommand, DeleteElementsCommand, InsertElementCommand, SplitElementsCommand } = await import(
	"@/commands/timeline"
);

// History is scene-bound: undo/redo first switch the editor to the scene the command ran in.

function setup(scenes: TScene[] = fixture()) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	// No autosave from these tests (it would write to storage after the test ends).
	editor.save.stop();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}

function title(name: string, start: number): InstanceType<typeof InsertElementCommand> {
	return new InsertElementCommand({
		element: {
			type: "text",
			name,
			startTime: t(start),
			duration: t(1),
			trimStart: t(0),
			trimEnd: t(0),
			params: { content: name },
		},
		placement: { mode: "auto" },
	});
}

function elementsIn(editor: ReturnType<typeof setup>, sceneId: string) {
	const scene = editor.scenes.getScenes().find((s) => s.id === sceneId);
	return scene ? allElements(allTracks(scene.tracks)) : [];
}

afterEach(() => {
	EditorCore.reset();
});

function setupSplitHistory() {
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks.main.elements = [video("a", 0, 2), video("b", 2, 2)];
	host.tracks.audio = [];
	const editor = setup(scenes);
	const tracks = () => editor.scenes.getActiveScene().tracks;
	const main = () => tracks().main.elements;
	const first = { trackId: "t-main", elementId: "a" };
	const second = { trackId: "t-main", elementId: "b" };
	const keyAt = (propertyPath: string, time: number, index = 0) =>
		getKeyframeAtTime({
			animations: main()[index].animations,
			propertyPath,
			time: t(time),
		});
	return { editor, tracks, main, first, second, keyAt };
}

test("large subtitle imports publish one complete track and keep its IDs and selection in history", () => {
	const editor = setup();
	editor.command.isRippleEnabled = true;
	const before = editor.scenes.getActiveScene().tracks;
	editor.selection.setSelectedElements({ elements: [refs[0]] });
	const captions = Array.from({ length: 128 }, (_, index) => ({
		text: `Cue ${index + 1}`,
		startTime: index * 1.5,
		duration: 2,
	}));
	let measurements = 0;
	let updates = 0;
	const unsubscribe = editor.timeline.subscribe(() => updates++);
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: { createElement: () => {
			measurements++;
			return { getContext: () => null };
		} },
	});
	try {
		const trackId = insertCaptionChunksAsTextTrack({
			editor,
			captions: [...captions, { text: "", startTime: 256, duration: 2 }],
		});
		const tracks = editor.scenes.getActiveScene().tracks;
		const imported = tracks.overlay[0];
		expect(updates).toBe(1);
		expect(measurements).toBe(1);
		expect(trackId).toBe(imported.id);
		expect(tracks.overlay.slice(1)).toEqual(before.overlay);
		expect(imported.elements.map(({ startTime, duration }) => [startTime, duration]))
			.toEqual(captions.map((cue) => [t(cue.startTime), t(cue.duration)]));
		const selection = [{ trackId: imported.id, elementId: imported.elements.at(-1)!.id }];
		expect(editor.selection.getSelectedElements()).toEqual(selection);

		editor.command.undo();
		expect(editor.scenes.getActiveScene().tracks).toBe(before);
		expect(editor.selection.getSelectedElements()).toEqual([refs[0]]);
		expect(editor.command.canUndo()).toBe(false);
		editor.command.redo();
		expect(editor.scenes.getActiveScene().tracks.overlay[0]).toBe(imported);
		expect(editor.selection.getSelectedElements()).toEqual(selection);
	} finally {
		unsubscribe();
		if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
	}
});

test("duration reads reuse the active track snapshot and refresh when tracks change", () => {
	const scenes = fixture();
	const clip = video("duration-probe", 0, 2);
	let durationReads = 0;
	Object.defineProperty(clip, "duration", {
		enumerable: true,
		get: () => {
			durationReads++;
			return t(2);
		},
	});
	const host = getHost(scenes);
	host.tracks.main.elements = [clip];
	host.tracks.overlay = [];
	host.tracks.audio = [];
	const editor = setup(scenes);
	expect(editor.timeline.getTotalDuration()).toBe(t(2));
	const reads = durationReads;
	for (let frame = 0; frame < 10; frame++) {
		expect(editor.timeline.getTotalDuration()).toBe(t(2));
	}
	expect(durationReads).toBe(reads);

	editor.timeline.updateElements({ updates: [{ trackId: host.tracks.main.id, elementId: clip.id, patch: { duration: t(1) } }] });
	expect(editor.timeline.getTotalDuration()).toBe(t(1));
	editor.command.undo();
	expect(editor.timeline.getTotalDuration()).toBe(t(2));
});

describe("split and ripple replay", () => {
	for (const retainSide of ["both", "right"] as const) {
		test(`redo restores the same right segment after a ${retainSide} split`, () => {
			const { editor, main, first } = setupSplitHistory();
			const right = editor.timeline.splitElements({ elements: [first], splitTime: t(1), retainSide });
			editor.timeline.deleteElements({ elements: right });
			const remaining = main().map((clip) => clip.id);

			editor.command.undo();
			editor.command.undo();
			editor.command.redo();
			expect(main().some((clip) => clip.id === right[0].elementId)).toBe(true);
			expect(editor.selection.getSelectedElements()).toEqual(right);
			editor.command.redo();
			expect(main().map((clip) => clip.id)).toEqual(remaining);
		});
	}

	for (const retainSide of ["both", "left", "right"] as const) {
		test(`a ${retainSide} split at either boundary leaves tracks and history alone`, () => {
			const { editor, tracks, first, second } = setupSplitHistory();
			editor.timeline.deleteElements({ elements: [second] });
			editor.command.undo();
			const before = tracks();
			let reactorRuns = 0;
			editor.command.registerReactor(() => reactorRuns++);

			for (const boundary of [0, 2]) {
				expect(editor.timeline.splitElements({
					elements: [first], splitTime: t(boundary), retainSide,
				})).toEqual([]);
				expect(tracks()).toBe(before);
				expect(editor.command.canUndo()).toBe(false);
				expect(editor.command.canRedo()).toBe(true);
			}
			expect(reactorRuns).toBe(0);
		});
	}

	test("a batch with only boundary splits leaves redo available", () => {
		const { editor, tracks, first, second } = setupSplitHistory();
		editor.timeline.deleteElements({ elements: [second] });
		editor.command.undo();
		const before = tracks();
		editor.command.execute({ command: new BatchCommand([
			new SplitElementsCommand({ elements: [first], splitTime: t(0) }),
			new BatchCommand([new SplitElementsCommand({ elements: [first], splitTime: t(2) })]),
		]) });
		expect(tracks()).toBe(before);
		expect(editor.command.canRedo()).toBe(true);
	});

	test("a split can change one selected clip while leaving a clip at its boundary alone", () => {
		const { editor, main, tracks, first } = setupSplitHistory();
		const untouched = tracks().overlay.find((track) => track.id === "t-gfx");
		const right = editor.timeline.splitElements({
			elements: [first, { trackId: "t-gfx", elementId: "box" }],
			splitTime: t(1),
		});
		expect(right).toHaveLength(1);
		expect(tracks().overlay.find((track) => track.id === "t-gfx")).toBe(untouched);
		expect(main()[0].duration).toBe(t(1));
	});

	for (const nested of [false, true]) {
		for (const ripple of [false, true]) {
			test(`redo uses ripple=${ripple} for a ${nested ? "nested" : "standalone"} delete`, () => {
				const { editor, main, first } = setupSplitHistory();
				editor.command.isRippleEnabled = ripple;
				const deletion = new DeleteElementsCommand({ elements: [first] });
				editor.command.execute({ command: nested ? new BatchCommand([new BatchCommand([deletion])]) : deletion });
				expect(main()[0].startTime).toBe(t(ripple ? 0 : 2));
				editor.command.undo();
				editor.command.isRippleEnabled = !ripple;
				editor.command.redo();
				expect(main()[0].startTime).toBe(t(ripple ? 0 : 2));
				expect(editor.command.isRippleEnabled).toBe(!ripple);
			});
		}
	}

	test("redo of a committed preview does not ripple", () => {
		const { editor, main, first } = setupSplitHistory();
		editor.command.isRippleEnabled = true;
		editor.timeline.previewElements({ updates: [{ ...first, updates: { duration: t(1) } }] });
		editor.timeline.commitPreview();
		expect(main()[1].startTime).toBe(t(2));
		editor.command.undo();
		editor.command.redo();
		expect(main()[0].duration).toBe(t(1));
		expect(main()[1].startTime).toBe(t(2));
	});
});

test("an animation duration drag previews every change and commits one undo entry", () => {
	const scenes = fixture();
	getHost(scenes).tracks.main.elements = [applyAnimationPresets(video("a", 0, 2), {
		in: { type: "fade" },
		out: { type: "fall" },
	})];
	const editor = setup(scenes);
	const clip = () => editor.scenes.getActiveScene().tracks.main.elements[0];
	for (const seconds of [0.5, 0.75, 1.25]) {
		editor.timeline.previewElements({
			updates: [{
				trackId: "t-main",
				elementId: "a",
				updates: { params: { ...clip().params, [PRESET_PARAM.inDuration]: seconds } },
			}],
		});
		const preview = editor.timeline.getPreviewTracks()?.main.elements[0];
		expect(preview?.params[PRESET_PARAM.inDuration]).toBe(seconds);
		expect(clip().params[PRESET_PARAM.inDuration]).toBe(0.3);
		expect(editor.command.canUndo()).toBe(false);
	}
	editor.timeline.commitPreview();
	expect(clip().params[PRESET_PARAM.inDuration]).toBe(1.25);
	expect(clip().params[PRESET_PARAM.outDuration]).toBe(0.5);
	editor.command.undo();
	expect(clip().params[PRESET_PARAM.inDuration]).toBe(0.3);
	expect(editor.command.canUndo()).toBe(false);
	editor.command.redo();
	expect(clip().params[PRESET_PARAM.inDuration]).toBe(1.25);
});

describe("preview gesture history boundaries", () => {
	for (const boundary of ["undo", "redo", "track replacement", "scene-list replacement", "scene switch", "scene initialization"] as const) {
		test(`a held canvas drag cannot overwrite ${boundary}`, async () => {
			const { editor, first, main, tracks } = setupSplitHistory();
			editor.timeline.updateElements({ updates: [{ ...first, patch: { params: { opacity: 0.4 } } }] });
			if (boundary === "redo") editor.command.undo();
			const destination = { ...editor.scenes.getActiveScene(), id: "next", isMain: false };
			editor.scenes.setScenes({ scenes: [...editor.scenes.getScenes(), destination] });
			const controller = new PreviewInteractionController({
				depsRef: {
					current: {
						viewport: {
							pointerCapture: new PreviewPointerCapture(),
							screenToCanvas: ({ clientX, clientY }) => ({ x: clientX, y: clientY }),
							screenPixelsToLogicalThreshold: () => ({ x: 0, y: 0 }),
						},
						input: { isShiftHeld: () => true },
						scene: {
							getTracks: tracks,
							getCurrentTime: () => 0,
							getMediaAssets: () => [],
							getCanvasSize: () => ({ width: 1920, height: 1080 }),
						},
						selection: {
							getSelected: () => editor.selection.getSelectedElements(),
							setSelected: (elements) => editor.selection.setSelectedElements({ elements: [...elements] }),
							clearSelection: () => editor.selection.clearSelection(),
						},
						timeline: {
							getElementsWithTracks: ({ elements }) => editor.timeline.getElementsWithTracks({ elements: [...elements] }),
							previewElements: (updates) => editor.timeline.previewElements({ updates }),
							commitPreview: () => editor.timeline.commitPreview(),
							beginPreviewGesture: editor.timeline.beginPreviewGesture,
						},
						playback: { getIsPlaying: () => false, subscribe: () => () => {} },
						preview: { isMaskMode: () => false },
					},
				},
			});
			let captured = false;
			const currentTarget = {
				ownerDocument: Object.assign(new EventTarget(), { activeElement: null }),
				setPointerCapture: () => { captured = true; },
				hasPointerCapture: () => captured,
				releasePointerCapture: () => { captured = false; },
			};
			const pointer = (x: number, type: string) => ({
				clientX: x, clientY: 540, pointerId: 1, button: 0, type, currentTarget,
			}) as unknown as ReactPointerEvent;
			try {
				controller.onPointerDown(pointer(960, "pointerdown"));
				controller.onPointerMove(pointer(980, "pointermove"));
				expect(editor.timeline.isPreviewActive()).toBe(true);

				const replacement = {
					...tracks(),
					main: {
						...tracks().main,
						elements: [{ ...main()[0], params: { opacity: 0.7 } }, main()[1]],
					},
				};
				if (boundary === "undo") editor.command.undo();
				else if (boundary === "redo") editor.command.redo();
				else if (boundary === "track replacement") editor.timeline.updateTracks(replacement);
				else if (boundary === "scene-list replacement") editor.scenes.setScenes({ scenes: [{ ...editor.scenes.getActiveScene(), tracks: replacement }] });
				else if (boundary === "scene switch") await editor.scenes.switchToScene({ sceneId: destination.id });
				else editor.scenes.initializeScenes({ scenes: editor.scenes.getScenes(), currentSceneId: destination.id });
				const after = tracks();
				expect(captured).toBe(false);
				controller.onPointerMove(pointer(1040, "pointermove"));
				controller.onPointerUp(pointer(1040, "pointerup"));
				expect(editor.timeline.isPreviewActive()).toBe(false);
				expect(tracks()).toBe(after);
				if (boundary === "undo") {
					expect(editor.command.canRedo()).toBe(true);
					editor.command.redo();
					expect(main()[0].params.opacity).toBe(0.4);
				}
			} finally {
				controller.destroy();
			}
		});
	}

	test("a replay without track changes cancels a gesture even before its first preview", async () => {
		const { editor, tracks } = setupSplitHistory();
		const before = tracks();
		await editor.scenes.toggleBookmark({ time: t(1) });
		let canceled = 0;
		editor.timeline.beginPreviewGesture(() => { canceled++; });
		editor.command.redo();
		expect(canceled).toBe(0);
		editor.command.undo();
		expect(tracks()).toBe(before);
		expect(canceled).toBe(1);
		expect(cancelInteraction()).toBe(false);
	});

	test("Cancel clears the preview, and a finished gesture can commit one history entry", () => {
		const { editor, first, main } = setupSplitHistory();
		let canceled = 0;
		editor.timeline.beginPreviewGesture(() => { canceled++; });
		editor.timeline.previewElements({ updates: [{ ...first, updates: { duration: t(1) } }] });
		expect(cancelInteraction()).toBe(true);
		expect(canceled).toBe(1);
		expect(editor.timeline.isPreviewActive()).toBe(false);
		expect(editor.command.canUndo()).toBe(false);

		const owner = editor.timeline.beginPreviewGesture(() => { canceled++; });
		editor.timeline.previewElements({ updates: [{ ...first, updates: { duration: t(1) } }] });
		owner.finish();
		editor.timeline.commitPreview();
		expect(main()[0].duration).toBe(t(1));
		expect(canceled).toBe(1);
		editor.command.undo();
		expect(main()[0].duration).toBe(t(2));
		expect(editor.command.canUndo()).toBe(false);
	});

	for (const source of ["canvas text", "properties field"] as const) {
		test(`clicking another clip saves the focused ${source} and still selects the clip`, () => {
			const { editor, first, second, main, tracks } = setupSplitHistory();
			const textOwner = source === "canvas text"
				? editor.timeline.beginPreviewGesture(() => {})
				: null;
			editor.timeline.previewElements({ updates: [{ ...first, updates: { name: "Pending title" } }] });

			const doc = Object.assign(new EventTarget(), {
				activeElement: {
					tagName: source === "canvas text" ? "DIV" : "TEXTAREA",
					isContentEditable: source === "canvas text",
					blur() {
						textOwner?.finish();
						editor.timeline.commitPreview();
					},
				},
			});
			const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
			Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
			const controller = new ElementInteractionController({
				depsRef: {
					current: {
						input: { isShiftHeld: () => false },
						scene: { getTracks: tracks, getActiveFps: () => null },
						selection: {
							getSelected: () => editor.selection.getSelectedElements(),
							isSelected: () => false,
							select: (ref) => editor.selection.setSelectedElements({ elements: [ref] }),
							handleClick: () => {},
							clearKeyframeSelection: () => editor.selection.clearKeyframeSelection(),
						},
						viewport: {
							getZoomLevel: () => 1,
							getTracksScrollEl: () => null,
							getTracksContainerEl: () => null,
							getHeaderEl: () => null,
						},
						timeline: {
							beginPreviewGesture: editor.timeline.beginPreviewGesture,
							moveElements: (args) => editor.timeline.moveElements(args),
						},
						playback: { getCurrentTime: editor.playback.getCurrentTime.bind(editor.playback) },
						snap: { isEnabled: () => false },
					},
				},
			});
			const event = {
				button: 0,
				clientX: 5,
				clientY: 5,
				stopPropagation: () => {},
				currentTarget: {
					ownerDocument: doc,
					getBoundingClientRect: () => ({ left: 0 }),
				},
			} as unknown as ReactMouseEvent;
			try {
				const clip = { event, element: main()[1], track: tracks().main };
				controller.onElementMouseDown(clip);
				// Native blur runs after mousedown if it was not already handled.
				if (editor.timeline.isPreviewActive()) doc.activeElement.blur();
				doc.dispatchEvent(new Event("mouseup"));
				controller.onElementClick(clip);
				expect(main()[0].name).toBe("Pending title");
				expect(editor.selection.getSelectedElements()).toEqual([second]);
				editor.command.undo();
				expect(main()[0].name).toBe("a");
			} finally {
				controller.destroy();
				if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
				else Reflect.deleteProperty(globalThis, "document");
			}
		});
	}

	test("Undo releases a held color control without committing its cached color", () => {
		const { editor, first, main } = setupSplitHistory();
		editor.timeline.updateElements({ updates: [{ ...first, patch: { name: "First edit" } }] });
		let captured = false;
		let commits = 0;
		const target = Object.assign(new EventTarget(), {
			ownerDocument: { defaultView: new EventTarget() },
			setPointerCapture: () => { captured = true; },
			hasPointerCapture: () => captured,
			releasePointerCapture: () => { captured = false; },
		});
		const start = () => startColorDrag({
			target: target as unknown as HTMLButtonElement,
			startEvent: { pointerId: 1, clientX: 0, clientY: 0 },
			readBaseline: () => ({ color: "ff0000" }),
			createColorReader: (color) => ({ clientX }) => clientX ? "00ff00" : color,
			onPreview: (color) => editor.timeline.previewElements({
				updates: [{ ...first, updates: { params: { color } } }],
			}),
			onCommit: (color) => {
				commits++;
				editor.timeline.updateElements({ updates: [{ ...first, patch: { params: { color } } }] });
			},
			onEnd: () => {},
			beginGesture: editor.timeline.beginPreviewGesture,
		});
		const pointer = (type: string, clientX: number) => {
			target.dispatchEvent(Object.assign(new Event(type), { pointerId: 1, clientX }));
		};

		start();
		expect(editor.timeline.isPreviewActive()).toBe(true);
		editor.command.undo();
		expect(captured).toBe(false);
		pointer("pointermove", 1);
		pointer("pointerup", 1);
		expect(commits).toBe(0);
		expect(editor.timeline.isPreviewActive()).toBe(false);
		expect(editor.command.canRedo()).toBe(true);
		editor.command.redo();
		expect(main()[0].name).toBe("First edit");

		start();
		pointer("pointermove", 1);
		pointer("pointerup", 1);
		expect(captured).toBe(false);
		expect(commits).toBe(1);
		expect(main()[0].params.color).toBe("00ff00");
	});

	test("opacity drag previews and restores the background committed on blur", async () => {
		const { editor } = setupSplitHistory();
		const original = { type: "color", color: "#112233" } as const;
		const typed = { type: "color", color: "#2266aa" } as const;
		await editor.project.updateSettings({ settings: { background: original }, pushHistory: false });
		const doc = {
			defaultView: new EventTarget(),
			activeElement: {
				tagName: "INPUT",
				blur() {
					void editor.project.updateSettings({ settings: { background: typed } });
				},
			},
		};
		const target = Object.assign(new EventTarget(), {
			ownerDocument: doc,
			setPointerCapture: () => {},
			hasPointerCapture: () => false,
		});
		let commits = 0;
		startColorDrag({
			target: target as unknown as HTMLButtonElement,
			startEvent: { pointerId: 1, clientX: 0, clientY: 0 },
			readBaseline: () => {
				const { background } = editor.project.getActive().settings;
				if (background.type !== "color") throw new Error("Expected a color background");
				return {
					color: background.color.slice(1),
					restore: () => {
						void editor.project.updateSettings({ settings: { background }, pushHistory: false });
					},
				};
			},
			createColorReader: (color) => {
				const { rgb } = parseHexAlpha({ hex: color });
				return () => appendAlpha({ rgbHex: rgb, alpha: 0.5 });
			},
			onPreview: (color) => {
				void editor.project.updateSettings({
					settings: { background: { type: "color", color: `#${color}` } },
					pushHistory: false,
				});
			},
			onCommit: () => { commits++; },
			onEnd: () => {},
			beginGesture: editor.timeline.beginPreviewGesture,
		});
		expect(editor.project.getActive().settings.background).toEqual({ type: "color", color: "#2266aa80" });
		expect(cancelInteraction()).toBe(true);
		target.dispatchEvent(Object.assign(new Event("pointerup"), { pointerId: 1 }));
		expect(editor.project.getActive().settings.background).toEqual(typed);
		expect(commits).toBe(0);
		editor.command.undo();
		expect(editor.project.getActive().settings.background).toEqual(original);
	});
});

describe("generated ids in history", () => {
	test("redo of separation keeps the audio clip, track and volume key ids", () => {
		const { editor, tracks, first } = setupSplitHistory();
		editor.media.setAssets({ assets: [
			{ id: "media-a", name: "a", type: "video", file: new File([], "a.mp4") },
		] });
		editor.timeline.upsertKeyframes({
			keyframes: [{ ...first, propertyPath: "volume", time: t(1), value: -6 }],
		});
		editor.timeline.toggleSourceAudioSeparation(first);
		const audio = tracks().audio[0];
		expect(audio?.elements).toHaveLength(1);
		editor.command.undo();
		expect(tracks().audio).toHaveLength(0);
		editor.command.redo();
		expect(tracks().audio[0]).toEqual(audio);
	});

	test("redo of effect creation keeps the effect id for later parameter edits", () => {
		const { editor, main, first } = setupSplitHistory();
		const effectId = editor.timeline.addClipEffect({ ...first, effectType: "blur" });
		editor.timeline.updateClipEffectParams({
			...first, effectId, params: { intensity: 30 },
		});
		editor.command.undo();
		editor.command.undo();
		editor.command.redo();
		editor.command.redo();
		const clip = main()[0];
		expect(clip.type === "video" && clip.effects?.[0]).toMatchObject({
			id: effectId,
			params: { intensity: 30 },
		});
	});

	test("redo of an effect parameter keyframe preserves its id", () => {
		const { editor, first, keyAt } = setupSplitHistory();
		const effectId = editor.timeline.addClipEffect({ ...first, effectType: "blur" });
		editor.timeline.upsertEffectParamKeyframe({
			...first, effectId, paramKey: "intensity", time: t(1), value: 30,
		});
		const propertyPath = buildEffectParamPath({ effectId, paramKey: "intensity" });
		const key = keyAt(propertyPath, 1);
		expect(key).not.toBeNull();
		editor.command.undo();
		editor.command.redo();
		expect(keyAt(propertyPath, 1)).toEqual(key);
	});

	test("redo of a new clip keyframe preserves its id", () => {
		const { editor, first, keyAt } = setupSplitHistory();
		const propertyPath = "opacity";
		editor.timeline.upsertKeyframes({
			keyframes: [{ ...first, propertyPath, time: t(1), value: 0.3 }],
		});
		const key = keyAt(propertyPath, 1);
		expect(key).not.toBeNull();
		editor.command.undo();
		editor.command.redo();
		expect(keyAt(propertyPath, 1)).toEqual(key);
	});

	test("redo of pasting keyframes preserves ids when overwriting or inserting keys", () => {
		const { editor, first, keyAt } = setupSplitHistory();
		const propertyPath = "opacity";
		editor.timeline.upsertKeyframes({
			keyframes: [{ ...first, propertyPath, time: t(0), value: 0.3 }],
		});
		const original = keyAt(propertyPath, 0);
		editor.command.execute({ command: new PasteKeyframesCommand({
			...first,
			time: t(0),
			clipboardItems: [0, 1].map((offset) => ({
				propertyPath, timeOffset: t(offset), value: 0.5, interpolation: "linear", curvePatches: [],
			})),
		}) });
		const pasted = [keyAt(propertyPath, 0), keyAt(propertyPath, 1)];
		expect(pasted[0]?.id).toBe(original?.id);
		expect(pasted[1]).not.toBeNull();
		editor.command.undo();
		editor.command.redo();
		expect([keyAt(propertyPath, 0), keyAt(propertyPath, 1)]).toEqual(pasted);
	});

	test("redo preserves new keyframe ids in both the source and the split boundary", () => {
		const { editor, first, keyAt } = setupSplitHistory();
		const propertyPath = "opacity";
		editor.timeline.upsertKeyframes({
			keyframes: [0, 2].map((time) => ({ ...first, propertyPath, time: t(time), value: time / 2 })),
		});
		const right = editor.timeline.splitElements({ elements: [first], splitTime: t(1) })[0];
		const leftKeys = [keyAt(propertyPath, 0), keyAt(propertyPath, 1)];
		const rightKeys = [keyAt(propertyPath, 0, 1), keyAt(propertyPath, 1, 1)];
		const boundaryId = rightKeys[0]?.id;
		if (!boundaryId) throw new Error("Expected a right boundary keyframe");
		editor.timeline.retimeKeyframe({ ...right, propertyPath, keyframeId: boundaryId, time: t(0.5) });
		expect(keyAt(propertyPath, 0.5, 1)?.id).toBe(boundaryId);

		editor.command.undo();
		editor.command.undo();
		editor.command.undo();
		editor.command.redo();
		editor.command.redo();
		expect([keyAt(propertyPath, 0), keyAt(propertyPath, 1)]).toEqual(leftKeys);
		expect([keyAt(propertyPath, 0, 1), keyAt(propertyPath, 1, 1)]).toEqual(rightKeys);
		editor.command.redo();
		expect(keyAt(propertyPath, 0.5, 1)?.id).toBe(boundaryId);
	});

	test("redo of a duration edit keeps the key synthesized at the new end", () => {
		const { editor, first, keyAt } = setupSplitHistory();
		const propertyPath = "opacity";
		editor.timeline.upsertKeyframes({
			keyframes: [0, 2].map((time) => ({ ...first, propertyPath, time: t(time), value: time / 2 })),
		});
		editor.timeline.updateElements({ updates: [{ ...first, patch: { duration: t(1) } }] });
		const boundary = keyAt(propertyPath, 1);
		expect(boundary).not.toBeNull();
		editor.command.undo();
		editor.command.redo();
		expect(keyAt(propertyPath, 1)).toEqual(boundary);
	});

	test("redo selects the same inserted mask point", () => {
		const scenes = fixture();
		const clip = video("masked", 0, 2);
		clip.masks = [{
			id: "mask",
			type: "freeform",
			params: {
				feather: 0, inverted: false, strokeColor: "#ffffff", strokeWidth: 0, strokeAlign: "center",
				centerX: 0, centerY: 0, rotation: 0, scale: 1, closed: false,
				path: [-0.25, 0.25].map((x, index) => ({
					id: String(index), x, y: 0, inX: 0, inY: 0, outX: 0, outY: 0,
				})),
			},
		}];
		getHost(scenes).tracks.main.elements = [clip];
		const editor = setup(scenes);
		editor.timeline.insertFreeformPathMaskPoint({
			trackId: "t-main", elementId: "masked", maskId: "mask", segmentIndex: 0,
			canvasPoint: { x: 100, y: 100 },
			bounds: { cx: 100, cy: 100, width: 200, height: 200, rotation: 0 },
		});
		const selected = editor.selection.getSnapshot().selectedMaskPoints;
		expect(selected?.pointIds).toHaveLength(1);
		editor.command.undo();
		editor.command.redo();
		expect(editor.selection.getSnapshot().selectedMaskPoints).toEqual(selected);
	});
});

describe("scene-bound history", () => {
	test("redo of a scene creation keeps its id, so a title inserted there comes back there", async () => {
		const editor = setup();
		const sceneId = await editor.scenes.createScene({ name: "A", isMain: false });
		const mainTrackId = editor.scenes.getScenes().find((s) => s.id === sceneId)?.tracks.main.id;
		await editor.scenes.switchToScene({ sceneId });
		const insert = title("hello", 0);
		editor.command.execute({ command: insert });
		expect(elementsIn(editor, sceneId).map((e) => e.name)).toEqual(["hello"]);

		editor.command.undo(); // the title, in A
		editor.command.undo(); // the scene, recorded in main → switches to main
		expect(editor.scenes.getScenes().some((s) => s.id === sceneId)).toBe(false);
		expect(editor.scenes.getActiveScene().id).toBe("main");

		editor.command.redo();
		expect(editor.scenes.getScenes().find((s) => s.id === sceneId)?.tracks.main.id).toBe(mainTrackId);
		editor.command.redo(); // recorded in A → switches to A
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(elementsIn(editor, sceneId).map((e) => e.name)).toEqual(["hello"]);
		expect(elementsIn(editor, "main").some((e) => e.name === "hello")).toBe(false);
	});

	test("a step whose scene no longer exists is refused and history is kept", async () => {
		const editor = setup();
		const sceneId = await editor.scenes.createScene({ name: "A", isMain: false });
		await editor.scenes.switchToScene({ sceneId });
		editor.command.execute({ command: title("hello", 0) });
		await editor.scenes.switchToScene({ sceneId: "main" });
		// The scene disappears outside history (e.g. a project sync).
		editor.scenes.setScenes({ scenes: editor.scenes.getScenes().filter((s) => s.id !== sceneId) });
		const mainBefore = editor.scenes.getActiveScene().tracks;

		editor.command.undo();
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(editor.scenes.getActiveScene().tracks).toBe(mainBefore);
		expect(elementsIn(editor, "main").some((e) => e.name === "hello")).toBe(false);
		expect(editor.command.canUndo()).toBe(true);
		expect(editor.command.canRedo()).toBe(false);
	});

	test("undoing the deletion of the open scene still works: that command brings the scene back", async () => {
		const editor = setup();
		const sceneId = await editor.scenes.createScene({ name: "A", isMain: false });
		await editor.scenes.switchToScene({ sceneId });
		await editor.scenes.deleteScene({ sceneId });
		expect(editor.scenes.getScenes().some((s) => s.id === sceneId)).toBe(false);

		editor.command.undo();
		expect(editor.scenes.getScenes().some((s) => s.id === sceneId)).toBe(true);
	});

	test("undo in another scene shows it at its own playhead; the open scene keeps its playhead", async () => {
		const editor = setup();
		const { sceneId } = editor.timeline.createCompound({ elements: refs }); // nested scene is 4 s
		await editor.scenes.switchToScene({ sceneId });
		editor.playback.seek({ time: t(2) });
		editor.command.execute({ command: title("nested", 0) });
		await editor.scenes.switchToScene({ sceneId: "main" }); // main is 10 s
		editor.playback.seek({ time: t(8) });

		editor.command.undo();
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(editor.playback.getCurrentTime()).toBe(t(2));

		await editor.scenes.switchToScene({ sceneId: "main" });
		expect(editor.playback.getCurrentTime()).toBe(t(8));
	});

	test("redo from another scene applies the command's selection in that scene", async () => {
		const editor = setup();
		const { sceneId } = editor.timeline.createCompound({ elements: refs });
		await editor.scenes.switchToScene({ sceneId });
		const insert = title("nested", 0);
		editor.command.execute({ command: insert });
		const inserted = { trackId: insert.getTrackId() ?? "", elementId: insert.getElementId() };
		expect(editor.selection.getSelectedElements()).toEqual([inserted]);

		editor.command.undo();
		await editor.scenes.switchToScene({ sceneId: "main" });
		editor.command.redo();
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(editor.selection.getSelectedElements()).toEqual([inserted]);
		// The track the redo recreated is the same one the selection points at.
		expect(
			editor.scenes.getActiveScene().tracks.overlay.some((track) => track.id === inserted.trackId),
		).toBe(true);
	});
});

describe("commands that remove clips", () => {
	test("removing a media asset is one history entry, returns its selection, and cleans compound content", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks.overlay = [
			...host.tracks.overlay,
			{ id: "t-clips", name: "Clips", type: "video", muted: false, hidden: false, elements: [video("clip", 1, 2)] },
		];
		const editor = setup(scenes);
		(editor.media as unknown as { assets: MediaAsset[] }).assets = [
			{ id: "media-clip", name: "clip", type: "video", file: new File([], "clip.mp4") } as MediaAsset,
		];
		// Put the clip inside a compound so the asset is used in a nested scene.
		const { compound, sceneId } = editor.timeline.createCompound({
			elements: [{ trackId: "t-clips", elementId: "clip" }],
		});
		editor.selection.setSelectedElements({ elements: [compound] });

		editor.command.execute({
			command: new RemoveMediaAssetCommand({ projectId: "p", assetId: "media-clip" }),
		});
		expect(elementsIn(editor, sceneId).some((e) => e.id === "clip")).toBe(false);
		expect(editor.selection.getSelectedElements()).toEqual([]);

		editor.command.undo();
		expect(elementsIn(editor, sceneId).some((e) => e.id === "clip")).toBe(true);
		expect(editor.media.getAssets().map((asset) => asset.id)).toEqual(["media-clip"]);
		// One entry for the removal; the next undo is the compound creation.
		editor.command.undo();
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);
		expect(editor.command.canUndo()).toBe(false);
	});

	test("ripple through nested and mixed batches leaves compound neighbours in place", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		const textTrack = host.tracks.overlay.find((track) => track.id === "t-text");
		if (!textTrack || textTrack.type !== "text") throw new Error("fixture");
		textTrack.elements.push({ ...(textTrack.elements[0] as TextElement), id: "neighbour", startTime: t(10) });
		host.tracks.main.elements.push(video("after-bg", 10, 2));
		const editor = setup(scenes);
		editor.command.isRippleEnabled = true;

		// Grouping inside nested batches: the neighbour title must stay at 10 s.
		editor.command.execute({
			command: new BatchCommand([new BatchCommand([new CreateCompoundCommand({ elements: refs })])]),
		});
		const startOf = (id: string) => elementsIn(editor, "main").find((e) => e.id === id)?.startTime;
		expect(startOf("neighbour")).toBe(t(10));
		editor.command.undo();
		expect(startOf("neighbour")).toBe(t(10));

		// Mixed batch: the compound child stays exempt, the delete still ripples.
		editor.command.execute({
			command: new BatchCommand([
				new CreateCompoundCommand({ elements: refs }),
				new DeleteElementsCommand({ elements: [{ trackId: "t-main", elementId: "bg" }] }),
			]),
		});
		expect(startOf("neighbour")).toBe(t(10));
		expect(startOf("after-bg")).toBe(t(0));
	});

	test("an agent draft ripples once on apply, undo and redo", async () => {
		const run = async (clips: [string, number][], expected: [string, number][]) => {
			const scenes = fixture();
			const host = getHost(scenes);
			const textTrack = host.tracks.overlay.find((track) => track.id === "t-text");
			if (!textTrack || textTrack.type !== "text") throw new Error("fixture");
			const template = textTrack.elements[0] as TextElement;
			textTrack.elements = clips.map(([id, start]) => ({ ...template, id, startTime: t(start), duration: t(2) }));
			const editor = setup(scenes);
			editor.command.isRippleEnabled = true;
			const startsOf = () =>
				Object.fromEntries(
					(editor.scenes.getActiveScene().tracks.overlay.find((track) => track.id === "t-text")?.elements ?? []).map(
						(e) => [e.id, e.startTime],
					),
				);
			const original = startsOf();

			await applyDraft({ schema: "opencut-agent-draft-1", rev: "r", label: "r", ops: [{ op: "delete", match: { id: "A" } }] });
			expect(startsOf()).toEqual(Object.fromEntries(expected.map(([id, start]) => [id, t(start)])));
			editor.command.undo();
			expect(startsOf()).toEqual(original);
			editor.command.redo();
			expect(startsOf()).toEqual(Object.fromEntries(expected.map(([id, start]) => [id, t(start)])));
		};
		await run(
			[
				["A", 0],
				["B", 8],
			],
			[["B", 6]],
		);
		await run(
			[
				["A", 0],
				["B", 2],
				["C", 4],
				["D", 10],
			],
			[
				["B", 0],
				["C", 2],
				["D", 8],
			],
		);
	});
});

describe("scene transitions", () => {
	for (const boundary of ["initialize with another scene", "initialize with the same scene ID", "clear"] as const) {
		test(`a pending preview is retired when scenes ${boundary}`, () => {
			const { editor, first, tracks } = setupSplitHistory();
			const source = editor.scenes.getActiveScene();
			const destination = {
				...source,
				id: boundary === "initialize with another scene" ? "next" : source.id,
				tracks: { ...source.tracks, main: { ...source.tracks.main, elements: [] } },
			};
			let canceled = false;
			editor.timeline.beginPreviewGesture(() => { canceled = true; });
			editor.timeline.previewElements({ updates: [{ ...first, updates: { duration: t(1) } }] });
			expect(editor.timeline.getPreviewTracks()).not.toBe(source.tracks);

			if (boundary === "clear") {
				editor.scenes.clearScenes();
				expect(editor.timeline.getPreviewTracks()).toBeNull();
				editor.scenes.initializeScenes({ scenes: [source] });
			} else {
				editor.scenes.initializeScenes({ scenes: [destination] });
			}

			expect(canceled).toBe(true);
			expect(editor.timeline.isPreviewActive()).toBe(false);
			editor.timeline.commitPreview();
			expect(tracks()).toBe(boundary === "clear" ? source.tracks : destination.tracks);
			expect(editor.command.canUndo()).toBe(false);
		});
	}

	test("a preview update received with no scene does not carry over to the next scene", () => {
		const { editor, first } = setupSplitHistory();
		const source = editor.scenes.getActiveScene();
		editor.scenes.clearScenes();
		editor.timeline.previewElements({ updates: [{ ...first, updates: { duration: t(1) } }] });
		expect(editor.timeline.isPreviewActive()).toBe(false);
		editor.scenes.initializeScenes({ scenes: [source] });
		editor.timeline.commitPreview();
		expect(editor.scenes.getActiveScene().tracks).toBe(source.tracks);
		expect(editor.command.canUndo()).toBe(false);
	});

	test("switching scenes discards the preview and publishes the restored destination", async () => {
		const { editor, tracks, first } = setupSplitHistory();
		const source = tracks();
		const destination = { ...editor.scenes.getActiveScene(), id: "next", isMain: false };
		editor.scenes.setScenes({ scenes: [...editor.scenes.getScenes(), destination] });
		await editor.scenes.switchToScene({ sceneId: destination.id });
		editor.playback.seek({ time: t(3) });
		await editor.scenes.switchToScene({ sceneId: "main" });
		editor.timeline.previewElements({ updates: [{ ...first, updates: { duration: t(1) } }] });
		expect(editor.timeline.getPreviewTracks()?.main.elements[0].duration).toBe(t(1));

		const publications: Array<{ id: string; time: number }> = [];
		const observe = () => publications.push({
			id: editor.scenes.getActiveScene().id,
			time: editor.playback.getCurrentTime(),
		});
		const unsubscribeTimeline = editor.timeline.subscribe(observe);
		const unsubscribeScenes = editor.scenes.subscribe(observe);
		try {
			await editor.scenes.switchToScene({ sceneId: destination.id });
			editor.timeline.commitPreview();
			expect(publications).toEqual([{ id: destination.id, time: t(3) }]);
		} finally {
			unsubscribeTimeline();
			unsubscribeScenes();
		}
		expect(tracks()).toBe(destination.tracks);
		expect(editor.timeline.isPreviewActive()).toBe(false);
		expect(editor.command.canUndo()).toBe(false);
		await editor.scenes.switchToScene({ sceneId: "main" });
		expect(editor.timeline.getPreviewTracks()).toBe(source);
	});

	async function sceneWithTitle(editor: ReturnType<typeof setup>) {
		const sceneId = await editor.scenes.createScene({ name: "A", isMain: false });
		await editor.scenes.switchToScene({ sceneId });
		const insert = new InsertElementCommand({
			element: {
				type: "text",
				name: "four seconds",
				startTime: t(0),
				duration: t(4),
				trimStart: t(0),
				trimEnd: t(0),
				params: { content: "four seconds" },
			},
			placement: { mode: "auto" },
		});
		editor.command.execute({ command: insert });
		return { sceneId, title: { trackId: insert.getTrackId() ?? "", elementId: insert.getElementId() } };
	}

	test("deleting the open scene and undoing it go through the same transition as a switch", async () => {
		const editor = setup();
		await editor.scenes.switchToScene({ sceneId: "main" });
		const { sceneId, title: titleRef } = await sceneWithTitle(editor);
		await editor.scenes.switchToScene({ sceneId: "main" });
		editor.playback.seek({ time: t(8) });
		await editor.scenes.switchToScene({ sceneId });
		editor.playback.seek({ time: t(2) });
		editor.selection.setSelectedElements({ elements: [titleRef] });

		await editor.scenes.deleteScene({ sceneId });
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(editor.playback.getCurrentTime()).toBe(t(8));
		expect(editor.selection.getSelectedElements()).toEqual([]);
		expect(editor.project.getActive().currentSceneId).toBe("main");

		editor.playback.seek({ time: t(9) });
		editor.command.undo();
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(editor.playback.getCurrentTime()).toBe(t(2));
		expect(editor.project.getActive().currentSceneId).toBe(sceneId);
		await editor.scenes.switchToScene({ sceneId: "main" });
		expect(editor.playback.getCurrentTime()).toBe(t(9));
	});

	test("a cross-scene undo while playing pauses at the restored playhead, never at a clamped time", async () => {
		const editor = setup();
		const { sceneId } = editor.timeline.createCompound({ elements: refs }); // nested scene is 4 s
		await editor.scenes.switchToScene({ sceneId });
		editor.playback.seek({ time: t(2) });
		editor.command.execute({ command: title("nested", 0) });
		await editor.scenes.switchToScene({ sceneId: "main" }); // main is 10 s
		editor.playback.seek({ time: t(8) });
		// Playing state without the frame clock (the clock is not under test).
		(editor.playback as unknown as { isPlaying: boolean }).isPlaying = true;
		expect(editor.playback.getIsPlaying()).toBe(true);

		const seeks: number[] = [];
		const stop = editor.playback.onSeek((time) => seeks.push(time));
		editor.command.undo();
		stop();
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(editor.playback.getCurrentTime()).toBe(t(2));
		expect(editor.playback.getIsPlaying()).toBe(false);
		expect(seeks).toEqual([t(2)]);
	});
});
