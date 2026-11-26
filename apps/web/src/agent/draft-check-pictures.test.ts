import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as processes from "@/retrieval/process";
import type { TScene, VideoElement } from "@/timeline";
import { mediaTimeFromSeconds } from "@/wasm";
import { inspectDraftPictures, pictureDefaults } from "./draft-check-pictures";
import { pictureBytes } from "./draft-picture-metrics";

test("preroll retains the active VFR frame and missing media does not stop other shots", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "draft-picture-timing-"));
	const projects = path.join(root, "projects"), directory = path.join(projects, "demo"), media = path.join(directory, "media");
	const ids = ["vanished", "vfr", "missing-tool"];
	await fs.mkdir(media, { recursive: true });
	const file = (id: string) => path.join(media, id + ".webm");
	const times = (seconds: number) => mediaTimeFromSeconds({ seconds });
	const element = (id: string, start: number): VideoElement => ({
		id, type: "video", name: id, mediaId: id, params: {}, startTime: times(start), duration: times(0.2),
		trimStart: times(1.1), trimEnd: times(0),
	});
	const scene = (elements: VideoElement[]): TScene => ({
		id: "scene", name: "scene", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
		tracks: { main: { id: "main", type: "video", name: "main", hidden: false, muted: true, elements }, overlay: [], audio: [] },
	});
	const inspect = (root: TScene) => inspectDraftPictures({ root, scenes: [root], directory, from: 0, to: 1,
		media: ids.map(id => ({ id, diskFile: id + ".webm", fileType: "video/webm" })),
		options: pictureDefaults, signal: new AbortController().signal, budgetMs: 5_000 });
	const seeks: number[] = [];
	const runner = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_exe, args) => {
		const input = args[args.indexOf("-i") + 1];
		if (input.endsWith("vanished.webm")) {
			await fs.unlink(input);
			await fs.stat(input); // The media disappeared after lookup, independently of FFmpeg availability.
		}
		if (input.endsWith("missing-tool.webm")) throw Object.assign(new Error("tool exited with code 127"), { code: "ENOENT" });
		seeks.push(Number(args[args.indexOf("-ss") + 1]));
		const raw = args.find(arg => arg.endsWith(".rgb"));
		if (!raw) throw new Error("missing decoder output");
		await fs.writeFile(raw, Buffer.alloc(3 * pictureBytes, 80));
		return { stdout: "#tb 0: 1/1000000\n0,0,200000,0,15552,0\n0,0,300000,33000,15552,0\n0,0,420000,0,15552,0\n", stderr: "" };
	});
	try {
		for (const id of ids) await fs.writeFile(file(id), "synthetic fixture");
		const report = await inspect(scene([element("vanished", 0), element("vfr", 0.2)]));
		expect(seeks).toHaveLength(1);
		expect(seeks[0]).toBeCloseTo(0.85);
		expect(report).toMatchObject({ sampled: 1, skipped: 1, missingFfmpeg: false,
			findings: [{ kind: "missing-picture-media", from: 0, to: 0.2, clips: [{ mediaId: "vanished" }] }] });
		expect(await inspect(scene([element("missing-tool", 0)]))).toMatchObject({ sampled: 0, skipped: 1, missingFfmpeg: true, findings: [] });
	} finally {
		runner.mockRestore();
		for (const id of ids.slice(1)) await fs.unlink(file(id));
		await fs.unlink(file(ids[0])).catch(() => {});
		for (const dir of [media, directory, projects, root]) await fs.rmdir(dir);
	}
});

test("a media file replaced during the picture pass is fingerprinted and decoded again", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "picture-file-change-"));
	const directory = path.join(root, "projects", "demo");
	const mediaDir = path.join(directory, "media");
	await fs.mkdir(mediaDir, { recursive: true });
	const mediaPath = path.join(mediaDir, "shared.webm");
	await fs.writeFile(mediaPath, "first version");
	const times = (seconds: number) => mediaTimeFromSeconds({ seconds });
	// Three clips show the same source range, so one decode serves all of them while the file stays the same.
	const element = (id: string, start: number): VideoElement => ({
		id, type: "video", name: id, mediaId: "shared", params: {}, startTime: times(start), duration: times(2),
		trimStart: times(0), trimEnd: times(0),
	});
	const scene: TScene = {
		id: "scene", name: "scene", isMain: true, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0),
		tracks: { main: { id: "main", type: "video", name: "main", hidden: false, muted: true,
			elements: [element("a", 0), element("b", 2), element("c", 4)] }, overlay: [], audio: [] },
	};
	let decodes = 0;
	const runner = spyOn(processes, "runBackgroundProcess").mockImplementation(async (_exe, args) => {
		decodes++;
		const raw = args.find((arg) => typeof arg === "string" && arg.endsWith(".rgb"));
		if (!raw) throw new Error("missing decoder output");
		await fs.writeFile(raw, Buffer.alloc(3 * pictureBytes, 30 + decodes));
		// The file is replaced while the first clip is decoded.
		if (decodes === 1) await fs.writeFile(mediaPath, "second, longer version");
		return { stdout: "#tb 0: 1/1000000\n0,0,200000,0,15552,0\n0,0,300000,33000,15552,0\n0,0,420000,0,15552,0\n", stderr: "" };
	});
	try {
		const report = await inspectDraftPictures({
			root: scene, scenes: [scene], directory, from: 0, to: 6,
			media: [{ id: "shared", diskFile: "shared.webm", fileType: "video/webm" }],
			options: { ...pictureDefaults, limit: 10 },
			signal: new AbortController().signal,
			budgetMs: 5_000,
		});
		// The first clip's decode read a file that changed, so it is not used; the others use the new file.
		expect(decodes).toBe(2);
		expect(report.sampled).toBe(2);
	} finally {
		runner.mockRestore();
		await fs.rm(root, { recursive: true, force: true });
	}
});
