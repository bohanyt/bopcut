import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { audio, fixture, t, text, video } from "@/timeline/__tests__/compound-fixtures";
import type { AudioElement } from "@/timeline";
import { alignNarration } from "./narration-alignment";
import { planNarration } from "./narration-plan";
import { handleCli } from "./cli-api";

const words = (source: string, shift = 0, step = 1) => source.split(" ").map((text, i) => ({
	text, start: shift + i * step, end: shift + i * step + step / 2,
}));

test("aligns by phrase context, numbers and casing while leaving inserts and removed words unmatched", () => {
	const before = words("Blue river seven opens bright sky again now yesterday closed");
	const after = words("blue river 7 opens uh bright sky again now freshly closed", 0.1);
	const { matches, limited } = alignNarration(before, after);
	expect(limited).toBe(false);
	expect(matches.map(({ old, next }) => [old, next])).toEqual([
		[0, 0], [1, 1], [2, 2], [3, 3], [4, 5], [5, 6], [6, 7], [7, 8], [9, 10],
	]);
});

test("reviews minor spelling and refuses repeated phrases with indistinguishable occurrences", () => {
	const a = words("blue river opens colour sunset coast returns today");
	const b = words("blue river opens color sunset coast returns today");
	expect(alignNarration(a, b).matches.find((match) => match.old === 3)?.confidence).toBe("review");
	expect(alignNarration(words("go now go now"), words("go now")).matches).toEqual([]);
});

test("bounds ambiguous windows, rejects overlapping timings and checks cancellation", () => {
	const repeated = words(Array(97).fill("go").join(" "));
	expect(alignNarration(repeated, repeated)).toEqual({ matches: [], limited: true });
	const broken = words("first second");
	broken[0].end = 2;
	expect(() => alignNarration(broken, repeated)).toThrow("non-overlapping");
	expect(() => alignNarration(repeated, repeated, () => { throw new Error("cancelled"); })).toThrow("cancelled");
});

const fps = { numerator: 30, denominator: 1 };
function setup() {
	const [root] = fixture();
	const clip = { ...audio("narration", 2, 7), sourceType: "upload", mediaId: "old" } satisfies AudioElement;
	root.tracks.audio[0].elements = [clip, audio("lead", 2.9, 0.5), audio("music", 40, 1)];
	return { root, fps, clipId: clip.id, mediaId: "new", check: () => {} };
}

test("plans word edges, pause fractions, effect lead and protected timing in project frames", () => {
	const input = setup();
	const oldWords = words("one small light stays in view");
	const newWords = words("1 small light stays in view", 0.3, 0.8);
	const clip = { ...video("protected", 3, 1.5), agentId: "protected", humanFields: ["duration"] };
	input.root.tracks.main.elements = [clip];
	const titles = input.root.tracks.overlay.find((track) => track.type === "text")!;
	titles.elements = [text("pause", 5, 0.75), text("unrelated", 20, 1)];
	input.root.bookmarks = [{ id: "note", time: t(5), elementIds: ["pause"] }, { id: "free", time: t(5) }];
	const plan = planNarration({ ...input, oldWords, newWords, newDuration: 5 });
	expect(plan.spans.items[0]).toMatchObject({ old: { start: 2 }, next: { start: 2.3 }, confidence: "high" });
	expect(plan.elements).toContainEqual(expect.objectContaining({ address: expect.objectContaining({ id: "protected" }),
		kind: "shorterThanProtectedContent", proposed: { startFrame: 93, endFrame: 129 }, humanEdited: expect.objectContaining({ duration: true }) }));
	expect(plan.elements.find((row) => row.address.id === "pause")?.anchor.end).toEqual({ pause: [4, 5], fraction: 0.5 });
	const lead = plan.elements.find((row) => row.address.id === "lead");
	expect(lead).toMatchObject({ kind: "move", proposed: { startFrame: 90, endFrame: 105 }, anchor: { end: null, keepDuration: true } });
	expect(lead?.anchor.start).toHaveProperty("leadSeconds", expect.closeTo(0.1));
	expect(plan.totals.unanchored).toBe(3);
	expect(plan.notes.items).toEqual([{ id: "note", old: { start: 5, end: 5 },
		proposed: { startFrame: 141, endFrame: 141 }, reason: "linked elements move together" }]);
	expect(plan.totals.unanchoredNotes).toBe(1);
});

test("CLI reads a large saved project without a running editor or changing its files", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "narration-plan-"));
	const previous = process.env.BOPENCUT_DATA;
	process.env.BOPENCUT_DATA = dir;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handleCli(req, "narration-plan", dir) });
	try {
		const projectDir = path.join(dir, "projects", "synthetic");
		const mediaDir = path.join(projectDir, "media", "_metadata");
		await fs.mkdir(mediaDir, { recursive: true });
		const { root } = setup();
		const recording = words(Array.from({ length: 1400 }, (_, i) => `word-${i}`).join(" "), 0, 0.4);
		const replacement = recording.map(({ text, start, end }) => ({ text, start: start + 0.1, end: end + 0.1 }));
		root.tracks.audio[0].elements = [{ ...audio("narration", 0, 600), mediaId: "old" }];
		root.tracks.main.elements = recording.slice(0, 850).map((w, i) => video(`picture-${i}`, w.start, w.end - w.start));
		root.tracks.overlay = [{
			id: "captions", name: "Captions", type: "text", hidden: false,
			elements: recording.slice(850, 1210).map((w, i) => ({
				...text(`caption-${i}`, w.start, w.end - w.start),
				params: { content: w.text }, caption: { approximate: false, words: [{ text: w.text, start: 0, end: w.end - w.start }] },
			})),
		}];
		const project = JSON.stringify({ metadata: { id: "synthetic" }, version: CURRENT_PROJECT_VERSION,
			settings: { fps }, currentSceneId: root.id, scenes: [root] });
		const saved = path.join(projectDir, "project.json");
		await fs.writeFile(saved, project);
		for (const [id, list] of [["old", recording], ["new", replacement]] as const) {
			await fs.writeFile(path.join(mediaDir, `${id}.json`), JSON.stringify({ name: id, type: "audio", duration: 600, words: list }));
		}
		const run = async (...options: string[]) => {
			const process = Bun.spawn([Bun.argv[0], "run", "agent", "narration-plan", "--project-id", "synthetic",
				"--clip", "narration", "--new-media", "new", "--url", server.url.origin, ...options], {
				cwd: path.resolve(import.meta.dir, "../../../.."), env: { ...Bun.env, BOPENCUT_DATA: dir }, stdout: "pipe", stderr: "pipe",
			});
			const [out, error, status] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
			if (status) throw new Error(error);
			return out;
		};
		const start = performance.now();
		const out = await run("--json");
		const elapsed = performance.now() - start;
		if (Bun.env.MEASURE_NARRATION_PLAN === "1") console.log(`narration-plan wall time: ${elapsed.toFixed(1)} ms; JSON: ${Buffer.byteLength(out)} B`);
		const plan = JSON.parse(out);
		expect(plan.totals).toMatchObject({ move: 1210, unmatched: 0, inserted: 0 });
		expect(plan.elements).toHaveLength(1210);
		expect(plan.elements[0].proposed).toEqual({ startFrame: 10203, endFrame: 10209 });
		expect(Buffer.byteLength(out)).toBeLessThan(1.6 * 1024 * 1024);
		expect(await run()).toContain("1210 moves");
		expect(await fs.readFile(saved, "utf8")).toBe(project);
		expect((await fs.readdir(projectDir)).sort()).toEqual(["media", "project.json"]);
	} finally {
		server.stop(true);
		if (previous === undefined) delete process.env.BOPENCUT_DATA;
		else process.env.BOPENCUT_DATA = previous;
		await fs.rm(dir, { force: true, recursive: true });
	}
}, 15_000);

test("reports inserts, conflicts across edited words, and limits proposals to valid sources", () => {
	const input = setup();
	input.root.tracks.main.elements = [video("across", 2, 2.5), video("short-source", 5, 2.5)];
	const oldWords = words("blue river opens bright sky again");
	const newWords = words("blue uh river opens bright sky again", 0.2, 1.2);
	const plan = planNarration({ ...input, oldWords, newWords, newDuration: 8 });
	expect(plan.inserted.items[0]).toMatchObject({ indices: [2, 2], words: ["uh"] });
	expect(plan.elements.find((row) => row.address.id === "across")).toMatchObject({ kind: "crossesUnresolvedChange", proposed: null });
	expect(plan.elements.find((row) => row.address.id === "short-source")).toMatchObject({ kind: "needsMoreSource" });
});

test("refuses split or retimed narration", () => {
	const input = setup();
	const args = { ...input, oldWords: words("one two"), newWords: words("one two"), newDuration: 3 };
	const track = input.root.tracks.audio[0];
	const narration = track.elements[0];
	if (narration.type !== "audio" || narration.sourceType !== "upload") throw new Error("Fixture must be an uploaded audio clip.");
	track.elements.push({ ...narration, id: "second-part" });
	expect(() => planNarration(args)).toThrow("multiple root audio clips");
	track.elements.pop();
	narration.retime = { rate: 1.2 };
	expect(() => planNarration(args)).toThrow("unretimed");
});
