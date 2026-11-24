import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Command } from "@/commands/base-command";
import type { TScene, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import { buildEffectParamPath } from "@/animation";
import { buildDefaultEffectInstance } from "@/effects";
import { allTracks, findCompound, fixture, getHost, refs, t, video } from "./compound-fixtures";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const commands = await import("@/commands/timeline");
const {
	AddClipEffectCommand, CreateCompoundCommand, DeleteElementsCommand, DeleteFreeformPathMaskPointsCommand,
	DuplicateElementsCommand, InsertElementCommand, InsertFreeformPathMaskPointCommand, MoveElementCommand,
	RemoveClipEffectCommand, RemoveEffectParamKeyframeCommand, RemoveKeyframeCommand, RemoveMaskCommand,
	RemoveTrackCommand, RenameCompoundCommand, ReorderClipEffectsCommand, RetimeKeyframesCommand,
	SplitElementsCommand, ToggleClipEffectCommand, ToggleMaskInvertedCommand, ToggleSourceAudioSeparationCommand,
	ToggleTrackMuteCommand, ToggleTrackVisibilityCommand, UngroupCompoundCommand, UpdateClipEffectParamsCommand,
	UpdateElementsCommand, UpdateScalarKeyframeCurveCommand, UpsertEffectParamKeyframeCommand, UpsertKeyframeCommand,
} = commands;

const MAIN = { trackId: "t-main", elementId: "bg" } as const;
const TITLE = { trackId: "t-text", elementId: "title" } as const;
const BOX = { trackId: "t-gfx", elementId: "box" } as const;
const MASKED = { trackId: "t-main", elementId: "masked", maskId: "mask" } as const;
const linearKey = (id: string, seconds: number, value: number) =>
	({ id, time: t(seconds), value, segmentToNext: "linear" as const, tangentMode: "auto" as const });

function withBookmark(scenes: TScene[] = fixture()) {
	getHost(scenes).bookmarks = [{ time: t(1), note: "marker" }];
	return scenes;
}

function setup(scenes: TScene[] = withBookmark()) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes, currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}

function snapshot(editor: ReturnType<typeof setup>) {
	return editor.scenes.getScenes().map(({ id, name, tracks, bookmarks }) => structuredClone({ id, name, tracks, bookmarks }));
}

function videoHost(patch?: (clip: VideoElement) => void) {
	const scenes = withBookmark();
	const clip = video("bg", 0, 10);
	patch?.(clip);
	getHost(scenes).tracks.main.elements = [clip];
	return scenes;
}

const blurClip = (id = "fx") => (clip: VideoElement) => {
	clip.effects = [buildDefaultEffectInstance({ effectType: "blur", id })];
};

function maskedHost() {
	const scenes = withBookmark();
	const clip = video("masked", 0, 2);
	clip.masks = [{
		id: "mask", type: "freeform",
		params: {
			feather: 0, inverted: false, strokeColor: "#fff", strokeWidth: 0, strokeAlign: "center",
			centerX: 0, centerY: 0, rotation: 0, scale: 1, closed: false,
			path: [
				{ id: "p0", x: -0.2, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
				{ id: "p1", x: 0.2, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
			],
		},
	}];
	getHost(scenes).tracks.main.elements = [clip];
	return scenes;
}

const withCompound = (editor: ReturnType<typeof setup>) => { editor.timeline.createCompound({ elements: refs }); };

// AddTrackCommand omitted: EditorCore's post-command reactor strips empty overlay/audio tracks after manager execute.

export const TIMELINE_UNDO_TABLE: {
	name: string; scenes?: () => TScene[]; ready?: (editor: ReturnType<typeof setup>) => void;
	command: (editor: ReturnType<typeof setup>) => Command;
}[] = [
	{ name: "InsertElementCommand", command: () => new InsertElementCommand({
		element: { type: "text", name: "cue", startTime: t(0), duration: t(1), trimStart: t(0), trimEnd: t(0), params: { content: "cue" } },
		placement: { mode: "auto" },
	}) },
	{ name: "DeleteElementsCommand", command: () => new DeleteElementsCommand({ elements: [BOX] }) },
	{ name: "DuplicateElementsCommand", command: () => new DuplicateElementsCommand({ elements: [TITLE] }) },
	{ name: "SplitElementsCommand", command: () => new SplitElementsCommand({ elements: [MAIN], splitTime: t(5) }) },
	{ name: "UpdateElementsCommand", command: () => new UpdateElementsCommand({ updates: [{ ...MAIN, patch: { name: "renamed" } }] }) },
	{ name: "ToggleSourceAudioSeparationCommand", ready: (editor) => {
		editor.media.setAssets({ assets: [{ id: "media-bg", name: "bg", type: "video", hasAudio: true, file: new File([], "bg.mp4") }] });
	}, command: () => new ToggleSourceAudioSeparationCommand(MAIN) },
	{ name: "MoveElementCommand", command: () => new MoveElementCommand({
		moves: [{ sourceTrackId: "t-text", targetTrackId: "t-text", elementId: "title", newStartTime: t(4) }],
	}) },
	{ name: "CreateCompoundCommand", command: () => new CreateCompoundCommand({ elements: refs }) },
	{ name: "RenameCompoundCommand", ready: withCompound, command: (editor) => new RenameCompoundCommand({
		sceneId: editor.scenes.getScenes().find((scene) => !scene.isMain)!.id, name: "Nested",
	}) },
	{ name: "UngroupCompoundCommand", ready: withCompound, command: (editor) => {
		const compound = findCompound(editor.scenes.getScenes());
		const track = allTracks(editor.scenes.getActiveScene().tracks).find((row) => row.elements.some((el) => el.id === compound.id));
		if (!track) throw new Error("compound track missing");
		return new UngroupCompoundCommand({ trackId: track.id, elementId: compound.id });
	} },
	{ name: "UpsertKeyframeCommand", command: () => new UpsertKeyframeCommand({ ...MAIN, propertyPath: "opacity", time: t(1), value: 0.5 }) },
	{ name: "RemoveKeyframeCommand", scenes: () => videoHost((clip) => {
		clip.animations = { opacity: { keys: [linearKey("k0", 0, 1)] } };
	}), command: () => new RemoveKeyframeCommand({ ...MAIN, propertyPath: "opacity", keyframeId: "k0", valueAtPlayhead: null }) },
	{ name: "RetimeKeyframesCommand", scenes: () => videoHost((clip) => {
		clip.animations = { opacity: { keys: [linearKey("k0", 0, 0)] } };
	}), command: () => new RetimeKeyframesCommand({ ...MAIN, keyframes: [{ propertyPath: "opacity", keyframeId: "k0", nextTime: t(2) }] }) },
	{ name: "UpdateScalarKeyframeCurveCommand", scenes: () => videoHost((clip) => {
		clip.animations = { opacity: { keys: [{
			id: "k0", time: t(0), value: 0, segmentToNext: "bezier", tangentMode: "broken",
			rightHandle: { dt: t(0.1), dv: 0.1 },
		}] } };
	}), command: () => new UpdateScalarKeyframeCurveCommand({
		...MAIN, propertyPath: "opacity", componentKey: "value", keyframeId: "k0",
		patch: { rightHandle: { dt: t(0.2), dv: 0.3 } },
	}) },
	{ name: "UpsertEffectParamKeyframeCommand", scenes: () => videoHost(blurClip()), command: () => new UpsertEffectParamKeyframeCommand({
		...MAIN, effectId: "fx", paramKey: "intensity", time: t(1), value: 20,
	}) },
	{ name: "RemoveEffectParamKeyframeCommand", scenes: () => videoHost((clip) => {
		blurClip()(clip);
		clip.animations = { [buildEffectParamPath({ effectId: "fx", paramKey: "intensity" })]: {
			keys: [linearKey("ek", 1, 10)],
		} };
	}), command: () => new RemoveEffectParamKeyframeCommand({ ...MAIN, effectId: "fx", paramKey: "intensity", keyframeId: "ek" }) },
	{ name: "AddClipEffectCommand", command: () => new AddClipEffectCommand({ ...MAIN, effectType: "blur" }) },
	{ name: "RemoveClipEffectCommand", scenes: () => videoHost(blurClip()), command: () => new RemoveClipEffectCommand({ ...MAIN, effectId: "fx" }) },
	{ name: "ToggleClipEffectCommand", scenes: () => videoHost(blurClip()), command: () => new ToggleClipEffectCommand({ ...MAIN, effectId: "fx" }) },
	{ name: "UpdateClipEffectParamsCommand", scenes: () => videoHost(blurClip()), command: () => new UpdateClipEffectParamsCommand({ ...MAIN, effectId: "fx", params: { intensity: 40 } }) },
	{ name: "ReorderClipEffectsCommand", scenes: () => videoHost((clip) => {
		clip.effects = [
			buildDefaultEffectInstance({ effectType: "blur", id: "fx0" }),
			buildDefaultEffectInstance({ effectType: "blur", id: "fx1" }),
		];
	}), command: () => new ReorderClipEffectsCommand({ ...MAIN, fromIndex: 0, toIndex: 1 }) },
	{ name: "InsertFreeformPathMaskPointCommand", scenes: maskedHost, command: () => new InsertFreeformPathMaskPointCommand({
		...MASKED, segmentIndex: 0, canvasPoint: { x: 0, y: 0 }, bounds: { cx: 0, cy: 0, width: 200, height: 200, rotation: 0 },
	}) },
	{ name: "DeleteFreeformPathMaskPointsCommand", scenes: maskedHost, command: () => new DeleteFreeformPathMaskPointsCommand({ ...MASKED, pointIds: ["p0"] }) },
	{ name: "RemoveMaskCommand", scenes: maskedHost, command: () => new RemoveMaskCommand(MASKED) },
	{ name: "ToggleMaskInvertedCommand", scenes: maskedHost, command: () => new ToggleMaskInvertedCommand(MASKED) },
	{ name: "RemoveTrackCommand", command: () => new RemoveTrackCommand("t-gfx") },
	{ name: "ToggleTrackMuteCommand", command: () => new ToggleTrackMuteCommand("t-main") },
	{ name: "ToggleTrackVisibilityCommand", command: () => new ToggleTrackVisibilityCommand("t-text") },
];

afterEach(() => { EditorCore.reset(); });

describe("timeline command undo table", () => {
	test.each(TIMELINE_UNDO_TABLE)("$name", ({ scenes, ready, command }) => {
		const editor = setup(scenes?.() ?? withBookmark());
		ready?.(editor);
		const before = snapshot(editor);
		const cmd = command(editor);
		editor.command.execute({ command: cmd });
		const after = snapshot(editor);
		expect(after).not.toEqual(before);
		editor.command.undo();
		expect(snapshot(editor)).toEqual(before);
		editor.command.redo();
		expect(snapshot(editor)).toEqual(after);
		editor.command.undo();
		expect(snapshot(editor)).toEqual(before);
	});
});