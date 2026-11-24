import { describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TextElement, TimelineElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { computeAgentDraft } = await import("./draft");
const { snapshotNotes } = await import("./notes");
const { SnapshotHistory, fieldsMapOf, fieldsOf: fieldOf, stableJson } = await import("./stale");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const text = (id: string, agentId: string, params: Record<string, unknown>) =>
	({ id, agentId, type: "text", name: id, startTime: T(0), duration: T(3), trimStart: T(0), trimEnd: T(0), params: { content: id, ...params } }) as unknown as TextElement;
const scenesWith = (elements: TimelineElement[]): TScene[] => [
	{
		id: "main", name: "main", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
		tracks: { main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, overlay: [{ id: "t-text", name: "Captions", type: "text", hidden: false, elements: elements as TextElement[] }], audio: [] } as unknown as SceneTracks,
	} as TScene,
];
const run = (scenes: TScene[], ops: any[], base?: Map<string, any>, ripple = false) =>
	computeAgentDraft({ scenes, rootSceneId: "main", ops, mediaFor: () => undefined, canvas: { width: 1080, height: 1920 }, fps: { numerator: 30, denominator: 1 }, ripple, base });
const paramOf = (scenes: TScene[], id: string, key: string) => (scenes[0].tracks.overlay[0].elements.find((e) => e.id === id) as TimelineElement).params[key];

describe("editing on top of the user's edits (basedOn)", () => {
	// The agent read this snapshot; afterwards the user changed a1's color and moved a2.
	const read = scenesWith([text("a1", "cap-1", { color: "#ffffff", fontSize: 4 }), text("a2", "cap-2", { color: "#ffffff" })]);
	const base = fieldsMapOf(read);
	const now = scenesWith([text("a1", "cap-1", { color: "#ff0000", fontSize: 4 }), { ...text("a2", "cap-2", { color: "#ffffff" }), startTime: T(1) } as TimelineElement]);

	test("a field the user did not touch still applies on an element the user edited", () => {
		const out = run(now, [{ op: "set", match: { agentId: "cap-1" }, params: { fontSize: 6 } }], base);
		expect(out.results[0]).toMatchObject({ ok: true });
		expect(paramOf(out.scenes, "a1", "fontSize")).toBe(6);
		expect(paramOf(out.scenes, "a1", "color")).toBe("#ff0000");
	});

	test("a field the user changed after basedOn is refused as stale, with the current value", () => {
		const out = run(now, [{ op: "set", match: { agentId: "cap-1" }, params: { color: "#ffff00", fontSize: 5 } }], base);
		expect(out.results[0]).toMatchObject({ ok: false, stale: true, fields: ["params.color"], current: { "params.color": "#ff0000" } });
		expect(paramOf(out.scenes, "a1", "color")).toBe("#ff0000");
		expect(paramOf(out.scenes, "a1", "fontSize")).toBe(4);
	});

	test("timing changes count too, and delete is refused when the element changed at all", () => {
		const move = run(now, [{ op: "set", match: { agentId: "cap-2" }, start: 2 }], base);
		expect(move.results[0]).toMatchObject({ ok: false, stale: true, fields: ["start"], current: { start: 1 } });
		const del = run(now, [{ op: "delete", match: { agentId: "cap-2" } }], base);
		expect(del.results[0]).toMatchObject({ ok: false, stale: true });
		const untouched = run(now, [{ op: "delete", match: { agentId: "cap-1" } }], fieldsMapOf(now));
		expect(untouched.results[0]).toMatchObject({ ok: true });
	});

	test("one stale op does not block the others; without basedOn nothing is checked", () => {
		const out = run(now, [{ op: "set", match: { agentId: "cap-1" }, params: { color: "#00ff00" } }, { op: "set", match: { agentId: "cap-2" }, params: { color: "#00ff00" } }], base);
		expect(out.results.map((r) => r.ok)).toEqual([false, true]);
		const legacy = run(now, [{ op: "set", match: { agentId: "cap-1" }, params: { color: "#00ff00" } }]);
		expect(legacy.results[0].ok).toBe(true);
	});

	test("history keeps recent snapshots by syncedAt", () => {
		const history = new SnapshotHistory(2);
		history.record("t1", read);
		history.record("t2", now);
		history.record("t3", now);
		expect(history.get("t1")).toBeUndefined();
		expect(history.get("t3")?.get("main:a1")?.fields.params.color).toBe(JSON.stringify("#ff0000"));
	});

	test("unchanged scene snapshots share an index but retain independent timestamps and roots", () => {
		const history = new SnapshotHistory(3);
		history.record("before", read, { projectId: "p", rootSceneId: "main" });
		history.record("same-tracks", read, { projectId: "p", rootSceneId: "another-root" });
		history.record("edited", now, { projectId: "p", rootSceneId: "main" });

		const before = history.get("before");
		expect(before).toBeDefined();
		expect(history.get("same-tracks")).toBe(before);
		expect(history.get("edited")).not.toBe(before);
		expect(history.state("before")?.rootSceneId).toBe("main");
		expect(history.state("same-tracks")?.rootSceneId).toBe("another-root");
		expect(before?.get("main:a1")?.fields.params.color).toBe(JSON.stringify("#ffffff"));
		expect(history.get("edited")?.get("main:a1")?.fields.params.color).toBe(JSON.stringify("#ff0000"));
	});

	test("two ops of one draft on the same field do not trip over each other", () => {
		const fresh = scenesWith([text("a1", "cap-1", { color: "#ffffff" })]);
		const out = run(fresh, [
			{ op: "set", match: { agentId: "cap-1" }, params: { color: "#00ff00" } },
			{ op: "set", match: { agentId: "cap-1" }, params: { color: "#0000ff" } },
		], fieldsMapOf(fresh));
		expect(out.results.map((r) => r.ok)).toEqual([true, true]);
		expect(paramOf(out.scenes, "a1", "color")).toBe("#0000ff");
	});

	test("an element added by an earlier op of the same draft can be set by a later one", () => {
		const fresh = scenesWith([text("a1", "cap-1", {})]);
		const out = run(fresh, [
			{ op: "add", track: { name: "Captions" }, element: { agent_id: "new", name: "new", text: "new", start: 4, duration: 1 } },
			{ op: "set", match: { agentId: "new" }, params: { color: "#ff00ff" } },
		], fieldsMapOf(fresh));
		expect(out.results.map((r) => r.ok)).toEqual([true, true]);
	});

	test("ripple never moves a clip the user moved after basedOn", () => {
		const clip = (id: string, start: number, duration: number) => ({ ...text(id, id, {}), startTime: T(start), duration: T(duration) }) as TimelineElement;
		const snapshot = scenesWith([clip("a", 0, 2), clip("b", 2, 2), clip("c", 4, 2)]);
		const base = fieldsMapOf(snapshot);
		// The user moved b to 2.5 s after the snapshot; then the agent shortens a, which ripples b and c.
		const moved = scenesWith([clip("a", 0, 2), clip("b", 2.5, 2), clip("c", 4.5, 2)]);
		const out = run(moved, [{ op: "set", match: { agentId: "a" }, duration: 1 }], base, true);
		expect(out.results[0]).toMatchObject({ ok: false, stale: true });
		expect(out.results[0].fields[0]).toContain("moved by ripple");
		expect(out.scenes[0].tracks.overlay[0].elements.map((e) => e.startTime)).toEqual([T(0), T(2.5), T(4.5)]);
		// Nothing moved by the user: the same op ripples as usual.
		const calm = run(snapshot, [{ op: "set", match: { agentId: "a" }, duration: 1 }], base, true);
		expect(calm.results[0]).toMatchObject({ ok: true });
	});

	test("delete is refused when the user changed what is inside a compound clip, or moved it to another track", () => {
		const content = (label: string): TScene => ({
			id: "inner", name: "inner", isMain: false, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
			tracks: { main: { id: "t-in", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, overlay: [{ id: "t-in-text", name: "Text", type: "text", hidden: false, elements: [text("label", "label", { content: label })] }], audio: [] } as unknown as SceneTracks,
		}) as TScene;
		const compound = { id: "box", agentId: "box", type: "compound", name: "box", sceneId: "inner", startTime: T(0), duration: T(3), trimStart: T(0), trimEnd: T(0), params: {} } as unknown as TimelineElement;
		const withCompound = (label: string, trackId = "t-text"): TScene[] => {
			const [root] = scenesWith([compound]);
			root.tracks.overlay[0] = { ...root.tracks.overlay[0], id: trackId } as never;
			return [root, content(label)];
		};
		const base = fieldsMapOf(withCompound("Helo"));
		const fixed = run(withCompound("Hello"), [{ op: "delete", match: { agentId: "box" } }], base);
		expect(fixed.results[0]).toMatchObject({ ok: false, stale: true, fields: ["content"] });
		const otherTrack = run(withCompound("Helo", "t-other"), [{ op: "delete", match: { agentId: "box" } }], base);
		expect(otherTrack.results[0]).toMatchObject({ ok: false, stale: true, fields: ["track"] });
		const untouched = run(withCompound("Helo"), [{ op: "delete", match: { agentId: "box" } }], base);
		expect(untouched.results[0]).toMatchObject({ ok: true });
	});

	test("key order does not make equal values differ", () => {
		expect(stableJson({ b: 1, a: { d: [2, 1], c: 3 } })).toBe(stableJson({ a: { c: 3, d: [2, 1] }, b: 1 }));
		expect(stableJson([2, 1])).not.toBe(stableJson([1, 2]));
	});

	test("unchanged elements share their record between snapshots", () => {
		const scenes = scenesWith([text("a1", "cap-1", {})]);
		const first = fieldsMapOf(scenes).get("main:a1")?.fields;
		const second = fieldsMapOf(scenes).get("main:a1")?.fields;
		expect(second).toBe(first);
	});

	test("a caption update on a caption the user corrected is refused as stale", () => {
		const snapshot = scenesWith([text("c1", "cap-1", { content: "Helo" })]);
		const corrected = scenesWith([text("c1", "cap-1", { content: "Hello" })]);
		const out = run(corrected, [{ op: "set", match: { agentId: "cap-1" }, caption: { text: "Helo!" } }], fieldsMapOf(snapshot));
		expect(out.results[0]).toMatchObject({ ok: false, stale: true, fields: ["element"] });
		expect(paramOf(out.scenes, "c1", "content")).toBe("Hello");
	});

	test("an element grouped by an earlier op of the draft is still checked", () => {
		const snapshot = scenesWith([text("c1", "cap-1", { content: "Helo" }), text("c2", "cap-2", {})]);
		const corrected = scenesWith([text("c1", "cap-1", { content: "Hello" }), text("c2", "cap-2", {})]);
		const out = run(corrected, [
			{ op: "group", match: [{ agentId: "cap-1" }, { agentId: "cap-2" }] },
			{ op: "set", match: { agentId: "cap-1" }, params: { content: "Helo!" } },
		], fieldsMapOf(snapshot));
		expect(out.results[0]).toMatchObject({ ok: true });
		expect(out.results[1]).toMatchObject({ ok: false, stale: true, fields: ["params.content"] });
	});

	test("a note the user added inside a compound clip makes its delete stale", () => {
		const content = (notes: unknown[]): TScene => ({
			id: "inner", name: "inner", isMain: false, bookmarks: notes, createdAt: new Date(0), updatedAt: new Date(0),
			tracks: { main: { id: "t-in", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, overlay: [], audio: [] } as unknown as SceneTracks,
		}) as TScene;
		const compound = { id: "box", agentId: "box", type: "compound", name: "box", sceneId: "inner", startTime: T(0), duration: T(3), trimStart: T(0), trimEnd: T(0), params: {} } as unknown as TimelineElement;
		const withNotes = (notes: unknown[]) => [scenesWith([compound])[0], content(notes)];
		const out = run(withNotes([{ time: 0, note: "fix this" }]), [{ op: "delete", match: { agentId: "box" } }], fieldsMapOf(withNotes([])));
		expect(out.results[0]).toMatchObject({ ok: false, stale: true, fields: ["content"] });
	});

	test("a moved element shares the serialized params of the element it replaced", () => {
		const element = text("m1", "m1", { svg: "x".repeat(2000) });
		const moved = { ...element, startTime: T(1) } as TimelineElement;
		expect(fieldOf(moved)).not.toBe(fieldOf(element));
		expect(fieldOf(moved).params).toBe(fieldOf(element).params);
		expect(fieldOf(moved).whole).not.toBe(fieldOf(element).whole);
	});

	test("ungrouping a compound the user changed inside (text or notes) is refused, and its content stays checked", () => {
		const content = (label: string, notes: unknown[] = []): TScene => ({
			id: "inner", name: "inner", isMain: false, bookmarks: notes, createdAt: new Date(0), updatedAt: new Date(0),
			tracks: { main: { id: "t-in", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, overlay: [{ id: "t-in-text", name: "Text", type: "text", hidden: false, elements: [text("label", "label", { content: label })] }], audio: [] } as unknown as SceneTracks,
		}) as TScene;
		const compound = { id: "box", agentId: "box", type: "compound", name: "box", sceneId: "inner", startTime: T(0), duration: T(3), trimStart: T(0), trimEnd: T(0), params: {} } as unknown as TimelineElement;
		const scenes = (label: string, notes: unknown[] = []) => [scenesWith([compound])[0], content(label, notes)];
		const base = fieldsMapOf(scenes("Helo"));
		const corrected = run(scenes("Hello"), [
			{ op: "ungroup", match: { agentId: "box" } },
			{ op: "set", match: { agentId: "label" }, params: { content: "Helo!" } },
		], base);
		expect(corrected.results.map((r) => r.stale)).toEqual([true, true]);
		const noted = run(scenes("Helo", [{ time: 0, note: "keep" }]), [{ op: "ungroup", match: { agentId: "box" } }], base);
		expect(noted.results[0]).toMatchObject({ ok: false, stale: true, fields: ["content"] });
		const untouched = run(scenes("Helo"), [{ op: "ungroup", match: { agentId: "box" } }], base);
		expect(untouched.results[0]).toMatchObject({ ok: true });
	});

	test("new text on a caption whose highlights the user changed is refused (the update would rewrite them)", () => {
		const caption = (highlight: boolean) => ({ ...text("c1", "cap-1", { content: "One two" }), caption: { words: [{ text: "One", start: 0, end: 0.5, highlight }, { text: "two", start: 0.5, end: 1 }] } }) as unknown as TimelineElement;
		const out = run(scenesWith([caption(true)]), [{ op: "set", match: { agentId: "cap-1" }, params: { content: "First two" } }], fieldsMapOf(scenesWith([caption(false)])));
		expect(out.results[0]).toMatchObject({ ok: false, stale: true, fields: ["caption"] });
		// A plain text element without caption data is checked on its text only.
		const plain = scenesWith([text("t1", "t-1", { content: "a" })]);
		const moved = scenesWith([{ ...text("t1", "t-1", { content: "a" }), startTime: T(1) } as TimelineElement]);
		expect(run(moved, [{ op: "set", match: { agentId: "t-1" }, params: { content: "b" } }], fieldsMapOf(plain)).results[0]).toMatchObject({ ok: true });
	});

	test("a compound this draft makes is checked by what it holds: group, then delete, cannot drop a correction", () => {
		const snapshot = scenesWith([text("c1", "cap-1", { content: "Helo" })]);
		const corrected = scenesWith([text("c1", "cap-1", { content: "Hello" })]);
		const ops = [{ op: "group", agent_id: "box", match: [{ agentId: "cap-1" }] }, { op: "delete", match: { agentId: "box" } }];
		const out = run(corrected, ops, fieldsMapOf(snapshot));
		expect(out.results[0]).toMatchObject({ ok: true });
		expect(out.results[1]).toMatchObject({ ok: false, stale: true, fields: ["element"] });
		// Nothing changed since the snapshot: the same draft applies.
		expect(run(snapshot, ops, fieldsMapOf(snapshot)).results.map((r) => r.ok)).toEqual([true, true]);
	});

	test("a track the user muted (or hid) since the snapshot protects its clips from delete, ungroup and group", () => {
		const muted = (scenes: TScene[]) => [{ ...scenes[0], tracks: { ...scenes[0].tracks, overlay: [{ ...scenes[0].tracks.overlay[0], muted: true }] } } as TScene];
		const snapshot = scenesWith([text("c1", "cap-1", {})]);
		const out = run(muted(snapshot), [{ op: "delete", match: { agentId: "cap-1" } }], fieldsMapOf(snapshot));
		expect(out.results[0]).toMatchObject({ ok: false, stale: true, fields: ["track"] });
		const grouped = run(muted(snapshot), [{ op: "group", match: [{ agentId: "cap-1" }] }], fieldsMapOf(snapshot));
		expect(grouped.results[0]).toMatchObject({ ok: false, stale: true, fields: ["track"] });
	});

	test("resolve-note does not close a note the user reopened since the snapshot", () => {
		const withNote = (resolved: boolean) => [{ ...scenesWith([])[0], bookmarks: [{ id: "n1", time: 0, note: "fix the logo", resolved }] } as unknown as TScene];
		const out = run(withNote(false), [{ op: "resolve-note", id: "n1" }], fieldsMapOf(withNote(true)));
		expect(out.results[0]).toMatchObject({ ok: false, stale: true, fields: ["note"] });
		expect((out.scenes[0].bookmarks[0] as { resolved?: boolean }).resolved).toBe(false);
		expect(run(withNote(false), [{ op: "resolve-note", id: "n1" }], fieldsMapOf(withNote(false))).results[0]).toMatchObject({ ok: true });
	});

	test("replies and resolutions find compound notes by their owning scene and reject stale edits", () => {
		const root = scenesWith([])[0];
		const note = { id: "shared", time: T(0), note: "Check the logo" };
		root.bookmarks = [note];
		root.tracks.main.elements = [{
			id: "clip", type: "compound", sceneId: "nested", name: "Nested",
			startTime: T(0), duration: T(2), trimStart: T(0), trimEnd: T(0), params: {},
		}];
		const nested: TScene = { ...scenesWith([])[0], id: "nested", kind: "compound", isMain: false, bookmarks: [note] };
		const scenes = [root, nested];
		expect(snapshotNotes(root, scenes, { width: 100, height: 100 }, []))
			.toContainEqual(expect.objectContaining({ id: "shared", text: "Check the logo", sceneId: "nested" }));
		expect(run(scenes, [{ op: "resolve-note", id: "shared" }]).results[0]).toMatchObject({ ok: false });
		const both = [
			{ op: "reply-note", id: "shared", sceneId: "nested", text: "Done" },
			{ op: "resolve-note", id: "shared", sceneId: "nested" },
		];
		const edited = run(scenes, both, fieldsMapOf(scenes));
		expect(edited.results.map((result) => result.ok)).toEqual([true, true]);
		expect(edited.scenes.find((scene) => scene.id === "nested")?.bookmarks[0]).toMatchObject({
			resolved: true, replies: [{ text: "Done" }],
		});
		expect(edited.scenes[0].bookmarks[0]).toEqual(note);
		const changed = { ...nested, bookmarks: [{ ...note, note: "Changed meanwhile" }] };
		expect(run([root, changed], both, fieldsMapOf(scenes)).results.map((result) => result.stale)).toEqual([true, true]);
	});

	test("notes are told apart by scene, and grouping a wrapper the draft made again is not refused", () => {
		const root = (resolved: boolean) => ({ ...scenesWith([])[0], bookmarks: [{ time: 0, note: "fix", resolved }] }) as unknown as TScene;
		const later = { ...scenesWith([])[0], id: "later", isMain: false, bookmarks: [{ time: 0, note: "other", resolved: true }] } as unknown as TScene;
		// Two legacy notes at the same time in different scenes: the root one was reopened.
		const out = run([root(false), later], [{ op: "resolve-note", id: "legacy-0" }], fieldsMapOf([root(true), later]));
		expect(out.results[0]).toMatchObject({ ok: false, stale: true, fields: ["note"] });

		const snapshot = scenesWith([text("c1", "cap-1", { content: "Helo" }), text("c2", "cap-2", {})]);
		const corrected = scenesWith([text("c1", "cap-1", { content: "Hello" }), text("c2", "cap-2", {})]);
		const nested = run(corrected, [
			{ op: "group", agent_id: "inner", match: [{ agentId: "cap-1" }] },
			{ op: "group", agent_id: "outer", match: [{ agentId: "inner" }, { agentId: "cap-2" }] },
		], fieldsMapOf(snapshot));
		expect(nested.results.map((r) => r.ok)).toEqual([true, true]);
	});
});
