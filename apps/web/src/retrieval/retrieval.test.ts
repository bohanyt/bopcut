import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Probe, type Runner, downloadArgs, encoderArgs, fetchFrame, fetchSection, formatSelector, handleRetrieve, splitCommand, toolsFromEnv } from "./server";
import { formatTime, linkAt, normalizeFrameRequest, normalizeSectionRequest, parseTime, timeFromUrl } from "./time";

describe("time parsing", () => {
	test("accepts seconds, clock and unit forms", () => {
		expect(parseTime("90")).toBe(90);
		expect(parseTime("90.5")).toBe(90.5);
		expect(parseTime("1:30")).toBe(90);
		expect(parseTime("01:02:03.25")).toBe(3723.25);
		expect(parseTime("1h2m3s")).toBe(3723);
		expect(parseTime("2m")).toBe(120);
		expect(parseTime("45s")).toBe(45);
		expect(parseTime("90:00")).toBe(5400);
		expect(parseTime(12)).toBe(12);
	});
	test("rejects invalid times", () => {
		for (const bad of ["", "abc", "1:75", "1:60:00", "-3", "1::2", "h"]) expect(Number.isNaN(parseTime(bad))).toBe(true);
		expect(Number.isNaN(parseTime(-1))).toBe(true);
		expect(Number.isNaN(parseTime(Number.POSITIVE_INFINITY))).toBe(true);
	});
	test("formats labels", () => {
		expect(formatTime(5)).toBe("0:05");
		expect(formatTime(65)).toBe("1:05");
		expect(formatTime(3723.25)).toBe("1:02:03.3");
		expect(formatTime(59.96)).toBe("1:00");
	});
	test("reads start times from links", () => {
		expect(timeFromUrl("https://www.youtube.com/watch?v=abc&t=754s")).toBe(754);
		expect(timeFromUrl("https://youtu.be/abc?t=1h2m")).toBe(3720);
		expect(timeFromUrl("https://example.com/v.mp4#t=12.5")).toBe(12.5);
		expect(timeFromUrl("https://example.com/watch?v=abc")).toBeUndefined();
		expect(timeFromUrl("not a url")).toBeUndefined();
	});
	test("builds a page link at the start time where the site supports it", () => {
		expect(linkAt("https://www.youtube.com/watch?v=abc", 75.9)).toBe("https://www.youtube.com/watch?v=abc&t=75s");
		expect(linkAt("https://www.youtube.com/watch?v=abc&t=10s", 20)).toBe("https://www.youtube.com/watch?v=abc&t=20s");
		expect(linkAt("https://example.com/v", 20)).toBe("https://example.com/v");
	});
});

describe("request validation", () => {
	test("section: start from the link, end from duration", () => {
		const r = normalizeSectionRequest({ url: "https://www.youtube.com/watch?v=abc&t=100", duration: "20" }, 1800);
		expect(r).toEqual({ ok: true, value: { url: "https://www.youtube.com/watch?v=abc&t=100", start: 100, end: 120 } });
	});
	test("section: explicit times, height and audioOnly", () => {
		const r = normalizeSectionRequest({ url: "https://example.com/v", start: "1:00", end: "1:10.5", height: 720, audioOnly: true }, 1800);
		expect(r).toEqual({ ok: true, value: { url: "https://example.com/v", start: 60, end: 70.5, height: 720, audioOnly: true } });
	});
	test("section: refuses bad links, missing or reversed times and whole videos", () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ url: "file:///etc/passwd", start: 0, end: 1 }, "url"],
			[{ url: "-o x", start: 0, end: 1 }, "url"],
			[{ url: "https://example.com/v", end: 10 }, "start is required"],
			[{ url: "https://example.com/v", start: 10 }, "end or duration"],
			[{ url: "https://example.com/v", start: 10, end: 5 }, "after start"],
			[{ url: "https://example.com/v", start: "x", end: 5 }, "start is not"],
			[{ url: "https://example.com/v", start: 0, end: 4000 }, "limit"],
			[{ url: "https://example.com/v", start: 0, end: 5, height: 99 }, "height"],
			[{ url: "https://example.com/v", start: 0, end: 5, audioOnly: "yes" }, "audioOnly"],
		];
		for (const [input, message] of cases) {
			const r = normalizeSectionRequest(input, 1800);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toContain(message);
		}
	});
	test("frame: time from the link or explicit", () => {
		expect(normalizeFrameRequest({ url: "https://youtu.be/abc?t=30" })).toEqual({ ok: true, value: { url: "https://youtu.be/abc?t=30", time: 30 } });
		expect(normalizeFrameRequest({ url: "https://example.com/v", time: "0:05", width: 640 })).toEqual({ ok: true, value: { url: "https://example.com/v", time: 5, width: 640 } });
		expect(normalizeFrameRequest({ url: "https://example.com/v" }).ok).toBe(false);
	});
});

describe("tools", () => {
	test("commands from the environment, with quoted paths", () => {
		const tools = toolsFromEnv({ BOPENCUT_YTDLP: "python -m yt_dlp", BOPENCUT_FFMPEG: '"/opt/my tools/ffmpeg"', BOPENCUT_VIDEO_ENCODER: "h264_nvenc", BOPENCUT_YTDLP_COOKIES_FROM_BROWSER: "firefox", BOPENCUT_RETRIEVE_MAX_SECONDS: "600" });
		expect(tools.ytdlp).toEqual(["python", "-m", "yt_dlp"]);
		expect(tools.ffmpeg).toEqual(["/opt/my tools/ffmpeg"]);
		expect(tools.cookiesFromBrowser).toBe("firefox");
		expect(tools.maxSectionSeconds).toBe(600);
		expect(toolsFromEnv({})).toMatchObject({ ytdlp: ["yt-dlp"], ffmpeg: ["ffmpeg"], videoEncoder: "libx264", defaultHeight: 1080, maxSectionSeconds: 1800 });
		expect(splitCommand("a 'b c' d")).toEqual(["a", "b c", "d"]);
	});
	test("encoder settings", () => {
		expect(encoderArgs("libx264")).toContain("-crf");
		expect(encoderArgs("h264_nvenc")).toEqual(["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "21"]);
		expect(encoderArgs("h264_qsv")).toEqual(["-c:v", "h264_qsv", "-b:v", "12M"]);
	});
});

describe("yt-dlp arguments", () => {
	const tools = { ...toolsFromEnv({}), ffmpeg: ["/opt/ffmpeg/bin/ffmpeg"], videoEncoder: "h264_nvenc", cookiesFromBrowser: "firefox" };
	test("a video section with frame-accurate cuts", () => {
		const args = downloadArgs({ url: "https://example.com/v", start: 10, end: 30.5, height: 1080, tools, output: "out/key.part.%(ext)s" });
		const joined = args.join(" ");
		expect(joined).toContain("--download-sections *10.000-30.500");
		expect(joined).toContain("--force-keyframes-at-cuts");
		expect(joined).toContain("ffmpeg_o:-c:v h264_nvenc -preset p5 -cq 21 -pix_fmt yuv420p -c:a aac -b:a 192k");
		expect(joined).toContain("--merge-output-format mp4");
		expect(joined).toContain("--cookies-from-browser firefox");
		expect(joined).toContain("--ffmpeg-location /opt/ffmpeg/bin/ffmpeg");
		expect(joined).toContain("--match-filter !is_live");
		expect(args.slice(-4)).toEqual(["-o", "out/key.part.%(ext)s", "--", "https://example.com/v"]);
	});
	test("audio only is extracted to m4a; ffmpeg on PATH needs no location", () => {
		const args = downloadArgs({ url: "https://example.com/v", start: 1, end: 2, height: 1080, audioOnly: true, tools: { ...tools, ffmpeg: ["ffmpeg"], cookiesFromBrowser: undefined }, output: "o.%(ext)s" });
		expect(args.join(" ")).toContain("-x --audio-format m4a");
		expect(args).not.toContain("--force-keyframes-at-cuts");
		expect(args).not.toContain("--ffmpeg-location");
		expect(args).not.toContain("--cookies-from-browser");
	});
	test("format selection prefers H.264 + AAC up to the height", () => {
		expect(formatSelector(720).startsWith("bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]")).toBe(true);
		expect(formatSelector(720, true)).toBe("ba[ext=m4a]/ba/b");
	});
});

describe("fetching", () => {
	let root: string;
	let calls: { command: string; args: string[] }[];
	const info: Probe = { title: "Long stream", uploader: "Someone", id: "abc", extractor_key: "Youtube", webpage_url: "https://www.youtube.com/watch?v=abc" };
	/** Fake yt-dlp/ffmpeg: yt-dlp prints the info JSON and writes the merged file; ffmpeg writes its last argument. */
	const fake =
		(printed: Probe | null, produce = true): Runner =>
		async (command, args) => {
			calls.push({ command, args });
			const o = args.indexOf("-o");
			if (o >= 0) {
				const template = args[o + 1] as string;
				if (produce) await fs.writeFile(template.replace("%(ext)s", args.includes("-x") ? "m4a" : "mp4"), "media");
				return { stdout: printed ? `[info] something\n${JSON.stringify(printed)}\n` : "", stderr: "" };
			}
			await fs.writeFile(args.at(-1) as string, "jpeg");
			return { stdout: "", stderr: "" };
		};
	const runner = fake(info);
	const tools = { ...toolsFromEnv({}), ytdlp: ["python", "-m", "yt_dlp"], cookiesFromBrowser: "firefox" };

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieve-test-"));
		calls = [];
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("a section is fetched once, saved with its source, and served from the cache after", async () => {
		const first = await fetchSection({ url: "https://www.youtube.com/watch?v=abc", start: 754, end: 774 }, { filesRoot: root, tools, runner });
		expect(first.cached).toBe(false);
		expect(first.type).toBe("video");
		expect(first.path).toMatch(/^retrieved\/[0-9a-f]{16}\.mp4$/);
		expect(first.name).toBe("Long stream 12:34-12:54");
		expect(first.source).toMatchObject({ link: "https://www.youtube.com/watch?v=abc&t=754s", title: "Long stream", uploader: "Someone", start: 754, end: 774 });
		expect(await fs.readFile(path.join(root, first.path), "utf8")).toBe("media");
		const call = calls[0];
		expect(call.command).toBe("python");
		expect(call.args.slice(0, 2)).toEqual(["-m", "yt_dlp"]);
		expect(call.args).toContain("--cookies-from-browser");
		expect(call.args.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=abc"]);
		const left = await fs.readdir(path.join(root, "retrieved"));
		expect(left.some((f) => f.includes(".part"))).toBe(false);

		const second = await fetchSection({ url: "https://www.youtube.com/watch?v=abc", start: 754, end: 774 }, { filesRoot: root, tools, runner });
		expect(second.cached).toBe(true);
		expect(second.path).toBe(first.path);
		expect(calls).toHaveLength(1);
	});

	test("concurrent identical requests share one fetch", async () => {
		const request = { url: "https://example.com/v", start: 0, end: 3 };
		const [a, b] = await Promise.all([fetchSection(request, { filesRoot: root, tools, runner }), fetchSection(request, { filesRoot: root, tools, runner })]);
		expect(a.path).toBe(b.path);
		expect(calls).toHaveLength(1);
	});

	test("audio only is saved as m4a", async () => {
		const r = await fetchSection({ url: "https://example.com/v", start: 0, end: 3, audioOnly: true }, { filesRoot: root, tools, runner });
		expect(r.type).toBe("audio");
		expect(r.path.endsWith(".m4a")).toBe(true);
	});

	test("a frame is grabbed as JPEG and its one-second download is removed", async () => {
		const r = await fetchFrame({ url: "https://example.com/v", time: 5 }, { filesRoot: root, tools, runner });
		expect(r.type).toBe("image");
		expect(r.path).toMatch(/^retrieved\/frames\/[0-9a-f]{16}\.jpg$/);
		expect(calls[0].args.join(" ")).toContain("--download-sections *5.000-6.000");
		expect(calls[1].args).toContain("-frames:v");
		const name = r.path.split("/").pop() as string;
		const left = await fs.readdir(path.join(root, "retrieved", "frames"));
		expect(left.sort()).toEqual([name, name.replace(".jpg", ".json")].sort());
	});

	test("live streams that are still running are refused", async () => {
		const live = await handleRetrieve({ kind: "section", url: "https://example.com/live", start: 0, end: 5 }, { filesRoot: root, tools, runner: fake({ ...info, is_live: true }, false) });
		expect(live.status).toBe(502);
		expect(JSON.stringify(live.body)).toContain("live stream");
		const skipped = await handleRetrieve({ kind: "section", url: "https://example.com/live2", start: 0, end: 5 }, { filesRoot: root, tools, runner: fake(null, false) });
		expect(skipped.status).toBe(502);
		expect(JSON.stringify(skipped.body)).toContain("nothing was downloaded");
	});

	test("missing tools and tool errors become clear messages; nothing partial is left", async () => {
		const missing: Runner = async () => {
			throw Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
		};
		const r1 = await handleRetrieve({ kind: "section", url: "https://example.com/v", start: 0, end: 5 }, { filesRoot: root, tools, runner: missing });
		expect(r1.status).toBe(502);
		expect(JSON.stringify(r1.body)).toContain("BOPENCUT_YTDLP");

		const failing: Runner = async (_command, args) => {
			const o = args.indexOf("-o");
			await fs.writeFile((args[o + 1] as string).replace("%(ext)s", "f399.mp4.part"), "half");
			throw Object.assign(new Error("exit 1"), { stderr: "size=  1KiB time=00:00:01\nERROR: Server returned 403 Forbidden" });
		};
		const r2 = await handleRetrieve({ kind: "section", url: "https://example.com/v", start: 0, end: 5 }, { filesRoot: root, tools, runner: failing });
		expect(r2.status).toBe(502);
		expect(JSON.stringify(r2.body)).toContain("403");
		expect(JSON.stringify(r2.body)).not.toContain("size=");
		expect((await fs.readdir(path.join(root, "retrieved"))).length).toBe(0);
	});

	test("bad requests are 400 and run nothing", async () => {
		expect((await handleRetrieve({ kind: "section", url: "https://example.com/v" }, { filesRoot: root, tools, runner })).status).toBe(400);
		expect((await handleRetrieve({ kind: "other" }, { filesRoot: root, tools, runner })).status).toBe(400);
		expect((await handleRetrieve(null, { filesRoot: root, tools, runner })).status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});
