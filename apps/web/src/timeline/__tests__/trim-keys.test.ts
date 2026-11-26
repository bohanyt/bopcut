import { afterEach, expect, test } from "bun:test";
import { getKeyframeAtTime, getKeyframeById } from "@/animation";
import { applyAnimationPresets } from "@/animation/presets";
import { EditorCore } from "@/core";
import { buildResizeMembers } from "@/timeline/controllers/resize-controller";
import { computeGroupResize } from "@/timeline/group-resize";
import type { VideoElement } from "@/timeline";
import { fixture, getHost, t, text, video } from "./compound-fixtures";

afterEach(() => EditorCore.reset());

const fps = { numerator: 30, denominator: 1 };
const animations = () => ({
	opacity: { keys: [
		{ id: "first", time: t(0), value: 0, segmentToNext: "linear" as const, tangentMode: "flat" as const },
		{ id: "surviving", time: t(3), value: 0.75, segmentToNext: "linear" as const, tangentMode: "flat" as const },
	] },
});

test.each([
	{ ripple: false, delta: 1 },
	{ ripple: true, delta: 1 },
	{ ripple: true, delta: -1 },
])("group left trim keeps keys in place at delta $delta with ripple $ripple", ({ ripple, delta }) => {
	// A lead clip keeps this trim independent of the main-track start anchor.
	const scenes = fixture();
	const host = getHost(scenes);
	const clip: VideoElement = {
		...video("retimed", 2, 5),
		sourceDuration: t(12),
		trimStart: t(2),
		retime: { rate: 2 },
		animations: animations(),
		params: { fadeIn: 0.4, fadeOut: 0.3 },
	};
	const title = applyAnimationPresets(
		{ ...text("title", 2, 5), trimStart: t(1), animations: animations() },
		{ in: { type: "fade", duration: 0.3 } },
	);
	host.tracks.main.elements = [video("lead", 0, 1), clip];
	host.tracks.overlay = [{ id: "titles", name: "Titles", type: "text", hidden: false, elements: [title as ReturnType<typeof text>] }];
	const editor = EditorCore.createRenderOnly();
	const date = new Date(0);
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "Project", duration: t(7), createdAt: date, updatedAt: date },
		currentSceneId: host.id, scenes, version: 1,
		settings: { fps, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } },
	} });
	editor.scenes.setScenes({ scenes, activeSceneId: host.id });
	editor.command.isRippleEnabled = ripple;
	const tracks = () => editor.scenes.getActiveScene().tracks;
	const before = tracks();
	const members = buildResizeMembers({ tracks: before, selectedElements: [
		{ trackId: host.tracks.main.id, elementId: clip.id },
		{ trackId: "titles", elementId: title.id },
	] });
	const { updates } = computeGroupResize({ members, side: "left", deltaTime: t(delta), fps });
	editor.timeline.updateElements({ updates });

	const after = tracks();
	for (const element of [after.main.elements[1], after.overlay[0].elements[0]]) {
		expect(element.startTime).toBe(t(2 + delta));
		expect(element.startTime + element.duration).toBe(t(7));
		const surviving = getKeyframeById({ animations: element.animations, propertyPath: "opacity", keyframeId: "surviving" });
		expect(element.startTime + surviving!.time).toBe(t(5));
		if (delta > 0) {
			const boundary = getKeyframeAtTime({ animations: element.animations, propertyPath: "opacity", time: t(0) });
			expect(boundary?.value).toBeCloseTo(0.25);
		}
	}
	expect(after.main.elements[1].trimStart).toBe(t(2 + delta * 2));
	expect(after.main.elements[1].params).toEqual(clip.params);
	expect(after.overlay[0].elements[0].params).toEqual(title.params);
	editor.command.undo();
	expect(tracks()).toEqual(before);
	expect(editor.command.canUndo()).toBe(false);
	editor.command.redo();
	expect(tracks()).toEqual(after);
});

test.each([0, 2])("left trim of the earliest main clip at %ps keeps keys on the footage", (start) => {
	// Nothing before the clip: the main track moves it to zero after the trim.
	const scenes = fixture();
	const host = getHost(scenes);
	const key = (id: string, time: number, value: number) =>
		({ id, time: t(time), value, segmentToNext: "linear" as const, tangentMode: "flat" as const });
	const clip: VideoElement = {
		...video("only", start, 5),
		sourceDuration: t(10),
		animations: { opacity: { keys: [key("a", 0, 0), key("b", 3, 0.75), key("c", 4.5, 1)] } },
	};
	host.tracks.main.elements = [clip];
	const editor = EditorCore.createRenderOnly();
	const date = new Date(0);
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "Project", duration: t(7), createdAt: date, updatedAt: date },
		currentSceneId: host.id, scenes, version: 1,
		settings: { fps, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } },
	} });
	editor.scenes.setScenes({ scenes, activeSceneId: host.id });
	editor.command.isRippleEnabled = false;
	const members = buildResizeMembers({
		tracks: editor.scenes.getActiveScene().tracks,
		selectedElements: [{ trackId: host.tracks.main.id, elementId: clip.id }],
	});
	const { updates } = computeGroupResize({ members, side: "left", deltaTime: t(1), fps });
	editor.timeline.updateElements({ updates });

	const after = editor.scenes.getActiveScene().tracks.main.elements[0];
	expect(after.startTime).toBe(t(0));
	expect(after.duration).toBe(t(4));
	expect(after.trimStart).toBe(t(1));
	const at = (id: string) => getKeyframeById({ animations: after.animations, propertyPath: "opacity", keyframeId: id })?.time;
	expect(at("a")).toBeUndefined();
	expect(at("b")).toBe(t(2));
	expect(at("c")).toBe(t(3.5));
	expect(getKeyframeAtTime({ animations: after.animations, propertyPath: "opacity", time: t(0) })?.value).toBeCloseTo(0.25);
});
