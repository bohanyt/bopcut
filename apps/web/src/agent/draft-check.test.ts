import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import type { ScalarAnimationKey } from "@/animation/types";
import type { CompoundElement, TScene, VideoElement, VideoTrack } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import { parseArgs } from "../../scripts/agent";
import { formatDraftReport, inspectDraft } from "./draft-check";

const ticks = (seconds: number) => mediaTimeFromSeconds({ seconds });
const canvas = { width: 1920, height: 1080 };
const shot = (id: string, mediaId: string, from: number, to: number, patch?: Partial<VideoElement>): VideoElement => ({
	type: "video", id, name: id, mediaId, startTime: ticks(from), duration: ticks(to - from),
	trimStart: ticks(0), trimEnd: ticks(0), params: {}, isSourceAudioEnabled: false, ...patch,
});
const track = (id: string, elements: VideoTrack["elements"], hidden = false): VideoTrack => ({
	id, name: id, type: "video", elements, hidden, muted: true,
});
const scene = (id: string, elements: VideoTrack["elements"], overlay: VideoTrack[] = []): TScene => ({
	id, name: id, isMain: id === "root", kind: id === "root" ? undefined : "compound", bookmarks: [],
	tracks: { main: track(id + "-main", elements), overlay, audio: [] }, createdAt: new Date(0), updatedAt: new Date(0),
});
const key = (id: string, time: number, value: number, segmentToNext: ScalarAnimationKey["segmentToNext"] = "linear"): ScalarAnimationKey => ({
	id, time: ticks(time), value, segmentToNext, tangentMode: "auto",
});
function inspect(root: TScene, scenes = [root], from = 0, to = 10) {
	return inspectDraft({ root, scenes, from, to, canvas, fps: 30, media: [], signal: new AbortController().signal });
}

test("counts five silent uses across a trimmed compound and unions simultaneous uses", () => {
	const nested = scene("nested", [shot("inside", "a", 1, 3)]);
	const compound: CompoundElement = {
		type: "compound", id: "outer", name: "outer", sceneId: nested.id, startTime: ticks(4),
		duration: ticks(2), params: {}, trimStart: ticks(2), trimEnd: ticks(0),
	};
	const disabled = Object.assign(shot("disabled", "a", 7, 8), { enabled: false });
	const root = scene("root", [shot("first", "a", 0, 1), shot("second", "a", 1, 2), shot("other", "b", 2, 4),
		compound, shot("last", "a", 6, 8), disabled, shot("invisible", "a", 8, 9, { params: { opacity: 0 } })],
		[track("overlay", [shot("overlap", "a", 6, 7)]), track("hidden", [shot("hidden", "a", 0, 10)], true)]);
	const report = inspect(root, [root, nested]);
	expect(report.sources[0]).toMatchObject({ mediaId: "a", uses: 5, seconds: 5, shortestGap: 0, share: 0.5 });
	expect(report.sources[0].clips[2]).toEqual({ from: 4, to: 5, address: { trackId: "nested-main", id: "inside", path: ["outer"] } });
	expect(report.runs).toEqual([expect.objectContaining({ mediaId: "a", from: 0, to: 2, uses: 2 })]);
	expect(inspect(root, [root, nested], 4.5, 7).sources[0]).toMatchObject({ uses: 3, seconds: 1.5, shortestGap: 0, share: 0.6 });
});

test("reports step and one-frame displacement, a linear speed change, and a measurable clip edge", () => {
	const move = shot("moving", "a", 2, 5, { animations: {
		"transform.positionX": { keys: [key("hold", 0, 0, "step"), key("jump", 1, 192)] },
		"transform.rotate": { keys: [key("spin", 0, 0), key("stop", 0.25, 90), key("still", 2, 90)] },
		"transform.scaleX": { keys: [key("small", 0.4, 1), key("big", 13 / 30, 1.12)] },
		opacity: { keys: [key("opaque", 1, 1, "step"), key("faded", 2, 0.5)] },
	} });
	const root = scene("root", [move]);
	const report = inspect(root);
	expect(report.motion).toContainEqual(expect.objectContaining({ kind: "keyframe-jump", at: 3, property: "transform.positionX", change: 0.1 }));
	expect(report.motion).toContainEqual(expect.objectContaining({ kind: "keyframe-jump", at: 2.433333, property: "transform.scaleX", change: 0.12 }));
	expect(report.motion).toContainEqual(expect.objectContaining({ kind: "keyframe-jump", at: 4, property: "opacity", change: -0.5 }));
	expect(report.motion).toContainEqual(expect.objectContaining({ kind: "speed-change", at: 2.266667, before: 12, after: 0, change: -12 }));
	expect(report.motion).toContainEqual(expect.objectContaining({ kind: "motion-at-start", at: 2, after: 12, unit: "degrees/frame" }));
	expect(inspect(root, [root], 2.1, 2.24).motion).toEqual([]);
});

test("a one-second pan and eased turn produce no motion or repeat findings", () => {
	const clean = scene("root", [shot("pan", "a", 0, 2, { animations: {
		"transform.positionX": { keys: [key("from", 0, 0), key("to", 1, 576)] },
		"transform.rotate": { keys: [
			{ ...key("from", 0, 0, "bezier"), rightHandle: { dt: ticks(1 / 3), dv: 0 } },
			{ ...key("to", 1, 90), leftHandle: { dt: ticks(-1 / 3), dv: 0 } },
		] },
	} }), shot("different", "b", 2, 3)]);
	const report = inspect(clean);
	expect(report.motion).toEqual([]);
	expect(report.runs).toEqual([]);
	expect(report.sources.map(({ uses }) => uses)).toEqual([1, 1]);
});

test("a default-handle Bézier has a measurable edge speed, peak, and change to a hold", () => {
	const root = scene("root", [shot("curve", "a", 0, 2, { animations: {
		"transform.rotate": { keys: [key("a", 0, 0, "bezier"), key("b", 0.5, 180, "step"), key("c", 1, 180)] },
	} })]);
	const { motion } = inspect(root);
	expect(motion.find(row => row.kind === "motion-at-start")?.after).toBeCloseTo(12, 3);
	expect(motion.find(row => row.kind === "peak-speed")?.change).toBeCloseTo(12, 3);
	expect(motion.find(row => row.kind === "speed-change")).toMatchObject({ at: 0.5, after: 0 });
	expect(motion.find(row => row.kind === "speed-change")?.change).toBeCloseTo(-12, 3);
});

test("measures a custom Bézier whose endpoint values are equal", () => {
	const root = scene("root", [shot("overshoot", "a", 0, 2, { animations: {
		"transform.rotate": { keys: [
			{ ...key("a", 0, 0, "bezier"), rightHandle: { dt: ticks(0.2), dv: 180 } },
			{ ...key("b", 0.6, 0), leftHandle: { dt: ticks(-0.2), dv: 0 } },
		] },
	} })]);
	const peak = inspect(root).motion.find(row => row.kind === "peak-speed");
	expect(peak?.change).toBeCloseTo(26.7593, 2);
	expect(peak?.at).toBe(0.033333);
});

test("two closely spaced subframe keys do not inflate a small rendered movement", () => {
	const root = scene("root", [shot("close", "a", 0, 2, { animations: {
		"transform.positionX": { keys: [key("a", 1.001, 0), key("b", 1.002, 10)] },
	} })]);
	expect(inspect(root).motion).toEqual([]);
});

test("a late repeat stays ahead of single-use sources within the report budget", () => {
	const singles = Array.from({ length: 100 }, (_, i) => shot("single-" + i, "source-" + i, i, i + 1));
	const repeats = Array.from({ length: 10 }, (_, i) => shot("repeat-" + i, "repeated", 100 + i, 101 + i));
	const root = scene("root", [...singles, ...repeats]);
	const report = inspect(root, [root], 0, 110);
	const text = String(formatDraftReport(report, false));
	expect(text).toContain("Single-use sources: 100");
	expect(text).toContain('"mediaId":"repeated","uses":10');
	expect(text).not.toContain('"mediaId":"source-0"');
	expect(String(formatDraftReport(report, false, true))).toContain('"mediaId":"source-0"');
	const json = formatDraftReport(report, true);
	if (typeof json === "string") throw new Error("Expected JSON data");
	expect(json.sources[0]).toMatchObject({ mediaId: "repeated", uses: 10 });
	expect(json.omitted.sources).toBeGreaterThan(0);
});

test("reports stable byte-bounded text and JSON with omitted counts", () => {
	const root = scene("root", Array.from({ length: 900 }, (_, i) => shot("é".repeat(80) + i, "source-" + i, i, i + 1)));
	const report = inspect(root, [root], 0, 900);
	const output = formatDraftReport(report, false);
	const json = formatDraftReport(report, true);
	expect(Buffer.byteLength(String(output))).toBeLessThan(20_000);
	expect(Buffer.byteLength(JSON.stringify(json))).toBeLessThan(20_000);
	if (typeof json === "string") throw new Error("Expected JSON data");
	expect(json.omitted.sources + json.sources.length).toBe(900);
	expect(formatDraftReport(report, false)).toBe(output);
});

test("draft-check reads the saved project directly and leaves its files alone", async () => {
	expect(parseArgs(["draft-check", "--project-id", "demo", "--from", "0.5", "--to", "2.5", "--position", ".05", "--json"]))
		.toMatchObject({ command: "draft-check", projectId: "demo", from: 0.5, to: 2.5, thresholds: { position: 0.05 }, json: true });
	expect(() => parseArgs(["draft-check", "--project-id", "demo", "--from", "2", "--to", "1"])).toThrow("--to");
	expect(() => parseArgs(["draft-check", "--project-id", "demo", "--opacity", "0"])).toThrow("--opacity");
	const root = await mkdtemp(path.join(tmpdir(), "draft-check-"));
	const projects = path.join(root, "projects");
	const directory = path.join(projects, "demo");
	const file = path.join(directory, "project.json");
	await mkdir(directory, { recursive: true });
	const saved = JSON.stringify({ version: CURRENT_PROJECT_VERSION, metadata: { id: "demo" },
		settings: { canvasSize: canvas, fps: { numerator: 30, denominator: 1 } }, scenes: [scene("root", [shot("silent", "a", 0, 3)])] });
	try {
		await writeFile(file, saved);
		const result = Bun.spawnSync([process.execPath, path.resolve(import.meta.dir, "../../scripts/agent.ts"), "draft-check",
			"--project-id", "demo", "--from", "0.5", "--to", "2.5", "--json"],
			{ env: { ...process.env, BOPENCUT_DATA: root, BOPENCUT_URL: "invalid" } });
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({
			from: 0.5, to: 2.5, sources: [{ mediaId: "a", uses: 1, seconds: 2, share: 1 }], motion: [], runs: [],
		});
		expect(await readFile(file, "utf8")).toBe(saved);
		expect(await readdir(directory)).toEqual(["project.json"]);
	} finally {
		await unlink(file);
		await rmdir(directory);
		await rmdir(projects);
		await rmdir(root);
	}
});
