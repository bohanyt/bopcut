import { afterEach, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import {
	scene,
	text,
	video,
	t,
	allTracks,
} from "@/timeline/__tests__/compound-fixtures";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { normalizeTrackHumanFields } from "@/timeline/human-fields";
import { buildSceneSnapshot } from "./snapshot";
import { computeAgentDraft, type Draft, type DraftOp } from "./draft";
import { fieldsMapOf } from "./stale";
import { AgentDraftCommand } from "./draft-command";
import { applyTextPreset, createTextPreset } from "@/text/presets";
import { makeCaption } from "@/text/caption";

const fps = { numerator: 30, denominator: 1 };
const canvas = { width: 1920, height: 1080 };
const ref = { trackId: "titles", elementId: "a" };
const word = { text: "correct", start: 0, end: 1, highlight: true };
const a = {
	...text("a", 1, 2),
	agentId: "phrase",
	params: { content: "correct", color: "#ff0000", opacity: 1 },
	caption: makeCaption("correct", 2, [word]),
};
const b = { ...text("b", 3, 2), agentId: "second" };
const manual = text("manual", 20, 2);
const v = {
	...video("video", 0, 5),
	agentId: "footage",
	sourceDuration: t(10),
	trimEnd: t(5),
};
const track = {
	id: "titles",
	type: "text" as const,
	name: "Titles",
	hidden: false,
};
const tracks: SceneTracks = {
	main: {
		id: "main-track",
		type: "video",
		name: "Main",
		hidden: false,
		muted: false,
		elements: [v],
	},
	overlay: [
		{ ...track, elements: [a, b, manual] },
		{
			...track,
			id: "second",
			name: "Second",
			elements: [text("anchor", 40, 1)],
		},
	],
	audio: [],
};
const scenes = [scene("main", tracks)];

function setup() {
	const editor = EditorCore.getInstance();
	editor.save.stop();
	editor.project.setActiveProject({
		project: {
			metadata: {
				id: "project",
				name: "Project",
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
			scenes,
			currentSceneId: "main",
			settings: { fps, canvasSize: canvas },
		} as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}
afterEach(() => EditorCore.reset());
const find = (source: typeof scenes, id: string) =>
	source
		.flatMap(({ tracks: layout }) =>
			allTracks(layout).flatMap((lane): TimelineElement[] => lane.elements),
		)
		.find((element) => element.id === id || element.agentId === id);
const run = (
	source: typeof scenes,
	ops: DraftOp[],
	onConflict?: Draft["onConflict"],
	base?: ReturnType<typeof fieldsMapOf>,
) =>
	computeAgentDraft({
		scenes: source,
		rootSceneId: "main",
		ops,
		onConflict,
		base,
		fps,
		canvas,
		mediaFor: () => undefined,
		ripple: false,
	});

test("committed inspector and preview edits mark only changed agent fields, with undo and redo", () => {
	const editor = setup();
	editor.timeline.previewElements({
		updates: [
			{ ...ref, updates: { params: { ...a.params, color: "#00ff00" } } },
		],
	});
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toBeUndefined();
	editor.timeline.discardPreview();
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toBeUndefined();
	editor.timeline.previewElements({
		updates: [
			{ ...ref, updates: { params: { ...a.params, color: "#00ff00" } } },
		],
	});
	editor.timeline.commitPreview();
	editor.timeline.updateElements({
		updates: [
			{ ...ref, patch: { startTime: t(1.1), params: { content: "fixed" } } },
			{
				trackId: "titles",
				elementId: "manual",
				patch: { params: { content: "mine" } },
			},
		],
	});
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toEqual([
		"caption",
		"params.color",
		"start",
	]);
	expect(
		find(editor.scenes.getScenes(), "manual")?.humanFields,
	).toBeUndefined();
	editor.command.undo();
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toEqual([
		"params.color",
	]);
	editor.command.asAgent(() => editor.command.redo());
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toEqual([
		"caption",
		"params.color",
		"start",
	]);
	editor.timeline.updateElements({
		updates: [{ ...ref, patch: { humanFields: undefined } }],
	});
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toBeUndefined();
	editor.command.undo();
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toContain(
		"caption",
	);
});

test("agent console command provenance, including redo, does not claim fields", () => {
	const editor = setup();
	editor.command.asAgent(() =>
		editor.timeline.updateElements({
			updates: [{ ...ref, patch: { params: { color: "#00ff00" } } }],
		}),
	);
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toBeUndefined();
	editor.command.undo();
	editor.command.redo();
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toBeUndefined();
});

test("move marks source track and start; ripple shifts do not mark the neighbor", () => {
	const editor = setup();
	editor.command.isRippleEnabled = true;
	editor.timeline.updateElements({ updates: [{ ...ref, patch: { duration: t(1) } }] });
	expect(find(editor.scenes.getScenes(), "b")?.startTime).toBe(t(2));
	expect(find(editor.scenes.getScenes(), "b")?.humanFields).toBeUndefined();
	editor.command.undo();
	editor.timeline.moveElements({
		moves: [
			{
				sourceTrackId: "titles",
				targetTrackId: "second",
				elementId: "a",
				newStartTime: t(7),
			},
		],
	});
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toEqual([
		"start",
		"track",
	]);
	expect(find(editor.scenes.getScenes(), "b")?.humanFields).toBeUndefined();
	editor.command.undo();
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toBeUndefined();
	editor.command.redo();
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toEqual([
		"start",
		"track",
	]);
});

test("retime, split and copies preserve the right ownership identities", () => {
	const editor = setup();
	editor.timeline.updateElementRetime({
		trackId: "main-track",
		elementId: "video",
		retime: { rate: 2 },
	});
	expect(find(editor.scenes.getScenes(), "video")?.humanFields).toContain(
		"retime",
	);
	editor.timeline.updateElements({
		updates: [{ ...ref, patch: { params: { color: "#00ff00" } } }],
	});
	const split = editor.timeline.splitElements({
		elements: [ref],
		splitTime: t(2),
	});
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toEqual([
		"duration",
		"params.color",
	]);
	expect(
		find(editor.scenes.getScenes(), split[0].elementId)?.humanFields,
	).toEqual(["duration", "params.color", "start", "trimStart"]);
	const copies = editor.timeline.duplicateElements({ elements: [ref] });
	expect(
		find(editor.scenes.getScenes(), copies[0].elementId)?.agentId,
	).toBeUndefined();
	expect(
		find(editor.scenes.getScenes(), copies[0].elementId)?.humanFields,
	).toBeUndefined();
	editor.selection.setSelectedElements({ elements: [ref] });
	expect(editor.clipboard.copy()).toBe(true);
	expect(editor.clipboard.paste({ time: t(12) })).toBe(true);
	const pasted = editor.selection.getSelectedElements()[0];
	expect(
		find(editor.scenes.getScenes(), pasted.elementId)?.humanFields,
	).toBeUndefined();
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toContain(
		"params.color",
	);
});

test("compound creation and break-apart carry ownership with retained children", () => {
	const editor = setup();
	editor.timeline.updateElements({
		updates: [{ ...ref, patch: { params: { color: "#00ff00" } } }],
	});
	const { compound } = editor.timeline.createCompound({ elements: [ref] });
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toEqual([
		"params.color",
	]);
	expect(
		find(editor.scenes.getScenes(), compound.elementId)?.humanFields,
	).toBeUndefined();
	editor.timeline.ungroupCompound(compound);
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toEqual([
		"params.color",
	]);
});

test("keep merges caption words and style separately, with take and legacy overrides", () => {
	const protectedClip = {
		...a,
		humanFields: ["caption", "params.color", "start"],
	};
	const input = [
		scene("main", {
			...tracks,
			overlay: [{ ...track, elements: [protectedClip, manual] }],
		}),
	];
	const update = {
		op: "set" as const,
		match: { agentId: "phrase" },
		start: 8,
		params: { color: "#00ff00", opacity: 0.5 },
		caption: { text: "replacement" },
	};
	const kept = run(input, [update], "keep");
	expect(kept.results[0]).toMatchObject({
		ok: true,
		kept: ["caption", "params.color", "start"],
	});
	expect(find(kept.scenes, "phrase")).toMatchObject({
		startTime: t(1),
		caption: a.caption,
		params: { content: "correct", color: "#ff0000", opacity: 0.5 },
	});
	const take = run(input, [{ ...update, take: ["caption"] }], "keep");
	expect(find(take.scenes, "phrase")).toMatchObject({
		params: { content: "replacement" },
		humanFields: ["params.color", "start"],
	});
	const legacy = run(input, [{ ...update, onConflict: "refuse" }], "keep");
	expect(find(legacy.scenes, "phrase")).toMatchObject({
		startTime: t(8),
		params: { content: "replacement", color: "#00ff00" },
	});
	expect(
		run(
			input,
			[{ op: "set", match: { id: "manual" }, params: { content: "explicit" } }],
			"keep",
		).results[0].ok,
	).toBe(true);
	const noop = run(
		input,
		[{ op: "set", match: { id: "a" }, start: 9 }],
		"keep",
	);
	expect(noop.scenes).toBe(input);
	expect(noop.results[0].kept).toEqual(["start"]);
});

test("same agentId replacement carries kept timing, track, appearance and caption in one undo", () => {
	const editor = setup();
	editor.timeline.moveElements({
		moves: [
			{
				sourceTrackId: "titles",
				targetTrackId: "second",
				elementId: "a",
				newStartTime: t(7),
			},
		],
	});
	editor.timeline.updateElements({
		updates: [
			{
				trackId: "second",
				elementId: "a",
				patch: { params: { color: "#00ff00", content: "fixed" } },
			},
		],
	});
	const before = editor.scenes.getScenes();
	const outcome = run(
		before,
		[
			{
				op: "replace",
				match: { agentId: "phrase" },
				track: { name: "Titles" },
				element: {
					start: 12,
					duration: 3,
					caption: { text: "regenerated" },
					params: { color: "#aaaaaa", opacity: 0.75 },
				},
			},
		],
		"keep",
	);
	expect(outcome.results[0]).toMatchObject({
		ok: true,
		kept: ["caption", "params.color", "start", "track"],
	});
	expect(
		outcome.scenes[0].tracks.overlay.find((lane) => lane.id === "second")
			?.elements,
	).toContainEqual(
		expect.objectContaining({
			agentId: "phrase",
			startTime: t(7),
			duration: t(3),
			params: expect.objectContaining({
				color: "#00ff00",
				content: "fixed",
				opacity: 0.75,
			}),
		}),
	);
	editor.command.execute({
		command: new AgentDraftCommand({
			before,
			after: outcome.scenes,
			selection: [],
		}),
	});
	editor.command.undo();
	expect(find(editor.scenes.getScenes(), "phrase")).toEqual(
		find(before, "phrase"),
	);
	editor.command.redo();
	expect(find(editor.scenes.getScenes(), "phrase")).toEqual(
		find(outcome.scenes, "phrase"),
	);
});

test("ownership is additive on snapshots and malformed loaded paths are dropped", () => {
	const dirty = {
		...tracks,
		overlay: [
			{
				...track,
				elements: [
					{
						...a,
						humanFields: [
							"start",
							"start",
							"malformed",
							"keyframes.effects.unknown",
						],
					},
					{ ...manual, humanFields: ["start"] },
				],
			},
		],
	};
	const clean = normalizeTrackHumanFields(dirty);
	expect(clean.overlay[0].elements[0].humanFields).toEqual(["start"]);
	expect(clean.overlay[0].elements[1].humanFields).toBeUndefined();
	expect(normalizeTrackHumanFields(tracks)).toBe(tracks);
	const snapshot = buildSceneSnapshot({
		scenes: [scene("main", clean)],
		rootSceneId: "main",
		mediaName: new Map(),
	});
	expect(snapshot.tracks[0].elements[0].humanFields).toEqual(["start"]);
});

test("keyframe keep and take work per property, while legacy basedOn still refuses", () => {
	const base = fieldsMapOf(scenes);
	const prepared = run(scenes, [
		{
			op: "set",
			match: { id: "a" },
			keyframes: [{ path: "opacity", time: 0, value: 0.8 }],
		},
	]);
	const next = prepared.scenes.map((item) => ({
		...item,
		tracks: {
			...item.tracks,
			overlay: item.tracks.overlay.map((lane) => ({
				...lane,
				elements: lane.elements.map((clip) =>
					clip.id === "a"
						? { ...clip, humanFields: ["keyframes.opacity"] }
						: clip,
				),
			})) as SceneTracks["overlay"],
		},
	}));
	const replace = {
		op: "set" as const,
		match: { id: "a" },
		keyframesMode: "replace" as const,
		keyframes: [
			{ path: "opacity", time: 0, value: 0.2 },
			{ path: "transform.positionX", time: 0, value: 20 },
		],
	};
	expect(run(next, [replace], undefined, base).results[0].stale).toBe(true);
	const kept = run(next, [replace], "keep", base);
	expect(kept.results[0]).toMatchObject({
		ok: true,
		kept: ["keyframes.opacity"],
	});
	expect(find(kept.scenes, "a")?.animations?.opacity).toEqual(
		find(next, "a")?.animations?.opacity,
	);
	expect(
		find(kept.scenes, "a")?.animations?.["transform.positionX"],
	).toBeDefined();
	const take = run(
		next,
		[{ ...replace, take: ["keyframes.opacity"] }],
		"keep",
		base,
	);
	expect(find(take.scenes, "a")?.humanFields).toBeUndefined();
});

test("human presets and keyframes mark actual properties, while effect edits do not", () => {
	const editor = setup();
	const preset = createTextPreset("Readable", {
		...a,
		params: { ...a.params, color: "#00ff00" },
	});
	editor.timeline.updateElements({
		updates: [{ ...ref, patch: applyTextPreset(a, preset) }],
	});
	editor.timeline.upsertKeyframes({
		keyframes: [
			{ ...ref, propertyPath: "opacity", time: t(0), value: 0.5 },
			{ ...ref, propertyPath: "transform.positionX", time: t(0), value: 20 },
		],
	});
	const fields = find(editor.scenes.getScenes(), "a")?.humanFields;
	expect(fields).toEqual(
		expect.arrayContaining([
			"params.color",
			"keyframes.opacity",
			"keyframes.transform.positionX",
		]),
	);
	expect(fields).not.toContain("caption");
	const effectId = editor.timeline.addClipEffect({
		...ref,
		effectType: "blur",
	});
	editor.timeline.upsertEffectParamKeyframe({
		...ref,
		effectId,
		paramKey: "intensity",
		time: t(0),
		value: 4,
	});
	expect(find(editor.scenes.getScenes(), "a")?.humanFields).toEqual(fields);
});

test("draft additions begin unowned and take is ignored in a legacy op", () => {
	const prep = run(scenes, [
		{
			op: "add",
			track: { name: "Titles" },
			element: {
				agent_id: "imported",
				name: "Imported",
				text: "draft content",
				start: 25,
				duration: 1,
			},
		},
	]);
	expect(find(prep.scenes, "imported")?.humanFields).toBeUndefined();
	const base = fieldsMapOf(scenes);
	const changed = [
		scene("main", {
			...tracks,
			overlay: [
				{
					...track,
					elements: [{ ...a, startTime: t(9), humanFields: ["start"] }],
				},
			],
		}),
	];
	const op = {
		op: "set" as const,
		match: { id: "a" },
		start: 8,
		take: ["start"],
	};
	expect(run(changed, [op], undefined, base).results[0].stale).toBe(true);
	expect(find(run(changed, [op]).scenes, "a")?.startTime).toBe(t(8));
	expect(
		find(run(changed, [op], "keep", base).scenes, "a")?.humanFields,
	).toBeUndefined();
});

test("keep leaves effect parameter stale checks and unbased rewrites unchanged", () => {
	const element = {
		agent_id: "blur",
		name: "Blur",
		start: 5,
		duration: 1,
		effect: "blur",
		effectParams: { intensity: 2 },
	};
	const added = run(scenes, [
		{ op: "add", track: { name: "Effects" }, element },
	]);
	const match = { agentId: "blur" };
	const set = (intensity: number): DraftOp => ({
		op: "set",
		match,
		params: { intensity },
	});
	const base = fieldsMapOf(added.scenes);
	const changed = run(added.scenes, [set(4)]);
	const changedBlur = find(changed.scenes, "blur");
	expect(changedBlur?.params.intensity).toBe(4);
	expect(changedBlur?.humanFields).toBeUndefined();
	const replace: DraftOp = { op: "replace", match, element };
	for (const op of [set(6), replace]) {
		const result = run(changed.scenes, [op], "keep", base);
		expect(result.results[0]).toMatchObject({ ok: false, stale: true });
		expect(find(result.scenes, "blur")?.params.intensity).toBe(4);
	}
	const unbased = run(changed.scenes, [set(6)], "keep");
	expect(unbased.results[0]).toMatchObject({ ok: true });
	expect(find(unbased.scenes, "blur")?.params.intensity).toBe(6);
});
