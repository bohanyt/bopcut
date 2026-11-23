import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Probe, type Runner, encoderArgs, fetchFrame, fetchSection, formatSelector, handleRetrieve, splitCommand, toolsFromEnv } from "./server";
import { formatTime, linkAt, normalizeFrameRequest, normalizeSectionRequest, parseTime, timeFromUrl } from "./time";
import { assertPublicUrl, isPrivateAddress } from "./net";
import { commandFromSetting, isPlaylistOnly } from "./server";

/** Tests below fetch nothing real; skip the DNS check for their example links. */
const LAN = { BOPENCUT_ALLOW_PRIVATE_URLS: "1" };

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

test("format selection prefers H.264 + AAC over other HTTP formats", () => {
	expect(formatSelector(720)).toContain("[height<=720][vcodec^=avc1]");
	expect(formatSelector(720, true)).toBe("ba[protocol^=http][protocol!*=segments][ext=m4a]/ba[protocol^=http][protocol!*=segments]/b[protocol^=http][protocol!*=segments]");
});

describe("fetching", () => {
	let root: string;
	let calls: { command: string; args: string[] }[];
	const info: Probe = { title: "Long stream", uploader: "Someone", id: "abc", extractor_key: "Youtube", webpage_url: "https://www.youtube.com/watch?v=abc", url: "https://example.com/media", protocol: "https" };
	const fake = (printed: Probe | null): Runner => async (command, args) => {
		calls.push({ command, args });
		if (args.includes("--skip-download")) return { stdout: printed ? JSON.stringify(printed) : "", stderr: "" };
		await fs.writeFile(args.at(-1) as string, args.includes("-frames:v") ? "jpeg" : "media");
		return { stdout: "", stderr: "" };
	};
	const runner = fake(info);
	const network = {
		env: LAN,
		fetchImpl: Object.assign(async () => new Response(null, { status: 206, headers: { "Content-Range": "bytes 0-0/6000000" } }), { preconnect: fetch.preconnect }),
	};
	const tools = { ...toolsFromEnv({}), ytdlp: ["python", "-m", "yt_dlp"], cookiesFromBrowser: "firefox" };

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "retrieve-test-"));
		calls = [];
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("a section is fetched once, saved with its source, and served from the cache after", async () => {
		const first = await fetchSection({ url: "https://www.youtube.com/watch?v=abc", start: 754, end: 774 }, { filesRoot: root, tools, runner, ...network });
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

		const second = await fetchSection({ url: "https://www.youtube.com/watch?v=abc", start: 754, end: 774 }, { filesRoot: root, tools, runner, ...network });
		expect(second.cached).toBe(true);
		expect(second.path).toBe(first.path);
		expect(calls).toHaveLength(2);
	});

	test("concurrent identical requests share one fetch", async () => {
		const request = { url: "https://example.com/v", start: 0, end: 3 };
		const [a, b] = await Promise.all([fetchSection(request, { filesRoot: root, tools, runner, ...network }), fetchSection(request, { filesRoot: root, tools, runner, ...network })]);
		expect(a.path).toBe(b.path);
		expect(calls).toHaveLength(2);
	});

	test("two roots never share an in-flight section", async () => {
		const request = { url: "https://example.com/v", start: 0, end: 3 };
		const other = path.join(root, "other");
		const results = await Promise.all([root, other].map((filesRoot) => fetchSection(request, { filesRoot, tools, runner, ...network })));
		await expect(fs.readFile(path.join(root, results[0].path), "utf8")).resolves.toBe("media");
		await expect(fs.readFile(path.join(other, results[1].path), "utf8")).resolves.toBe("media");
		expect(calls).toHaveLength(4);
	});

	test("audio only is saved as m4a", async () => {
		const r = await fetchSection({ url: "https://example.com/v", start: 0, end: 3, audioOnly: true }, { filesRoot: root, tools, runner, ...network });
		expect(r.type).toBe("audio");
		expect(r.path.endsWith(".m4a")).toBe(true);
	});

	test("a frame is grabbed as JPEG and its one-second download is removed", async () => {
		const r = await fetchFrame({ url: "https://example.com/v", time: 5 }, { filesRoot: root, tools, runner, ...network });
		expect(r.type).toBe("image");
		expect(r.path).toMatch(/^retrieved\/frames\/[0-9a-f]{16}\.jpg$/);
		expect(calls[1].args.join(" ")).toContain("-ss 5");
		expect(calls[2].args).toContain("-frames:v");
		const name = r.path.split("/").pop() as string;
		const left = await fs.readdir(path.join(root, "retrieved", "frames"));
		expect(left.sort()).toEqual([name, name.replace(".jpg", ".json")].sort());
	});

	test("live streams that are still running are refused", async () => {
		const live = await handleRetrieve({ kind: "section", url: "https://example.com/live", start: 0, end: 5 }, { filesRoot: root, tools, env: LAN, runner: fake({ ...info, is_live: true }) });
		expect(live.status).toBe(502);
		expect(JSON.stringify(live.body)).toContain("live stream");
		const skipped = await handleRetrieve({ kind: "section", url: "https://example.com/live2", start: 0, end: 5 }, { filesRoot: root, tools, env: LAN, runner: fake(null) });
		expect(skipped.status).toBe(502);
		expect(JSON.stringify(skipped.body)).toContain("nothing was downloaded");
	});

	test("missing tools and tool errors become clear messages; nothing partial is left", async () => {
		const missing: Runner = async () => {
			throw Object.assign(new Error("spawn yt-dlp ENOENT"), { code: "ENOENT" });
		};
		const r1 = await handleRetrieve({ kind: "section", url: "https://example.com/v", start: 0, end: 5 }, { filesRoot: root, tools, env: LAN, runner: missing });
		expect(r1.status).toBe(502);
		expect(JSON.stringify(r1.body)).toContain("BOPENCUT_YTDLP");

		const failing: Runner = async (_command, _args, _signal, cwd) => {
			await fs.writeFile(path.join(cwd!, "partial"), "half");
			throw Object.assign(new Error("exit 1"), { stderr: "size=  1KiB time=00:00:01\nERROR: Server returned 403 Forbidden" });
		};
		const r2 = await handleRetrieve({ kind: "section", url: "https://example.com/v", start: 0, end: 5 }, { filesRoot: root, tools, env: LAN, runner: failing });
		expect(r2.status).toBe(502);
		expect(JSON.stringify(r2.body)).toContain("403");
		expect(JSON.stringify(r2.body)).not.toContain("size=");
		expect((await fs.readdir(path.join(root, ".retrieval-jobs"))).length).toBe(0);
	});

	test("bad requests are 400 and run nothing", async () => {
		expect((await handleRetrieve({ kind: "section", url: "https://example.com/v" }, { filesRoot: root, tools, runner, ...network })).status).toBe(400);
		expect((await handleRetrieve({ kind: "other" }, { filesRoot: root, tools, runner, ...network })).status).toBe(400);
		expect((await handleRetrieve(null, { filesRoot: root, tools, runner, ...network })).status).toBe(400);
		expect(calls).toHaveLength(0);
	});
});

describe("network policy and settings", () => {
	test("private, loopback and link-local addresses are recognised", () => {
		for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
		for (const ip of ["8.8.8.8", "142.250.1.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
	});
	test("links resolving to this machine or the LAN are refused unless allowed", async () => {
		const resolve = (async (host: string) => (host === "evil.example" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }])) as never;
		await expect(assertPublicUrl("https://evil.example/x", {}, resolve)).rejects.toThrow("local network");
		await expect(assertPublicUrl("http://localhost:8080/x", {}, resolve)).rejects.toThrow("local network");
		await expect(assertPublicUrl("http://192.168.0.5/x", {}, resolve)).rejects.toThrow("local network");
		await expect(assertPublicUrl("https://www.example.com/x", {}, resolve)).resolves.toBeUndefined();
		await expect(assertPublicUrl("http://192.168.0.5/x", { BOPENCUT_ALLOW_PRIVATE_URLS: "1" }, resolve)).resolves.toBeUndefined();
	});
	test("an existing executable path with spaces stays one argument", () => {
		const exists = (p: string) => p === "C:/Program Files/ffmpeg/bin/ffmpeg.exe";
		expect(commandFromSetting("C:/Program Files/ffmpeg/bin/ffmpeg.exe", "ffmpeg", exists)).toEqual(["C:/Program Files/ffmpeg/bin/ffmpeg.exe"]);
		expect(commandFromSetting('"C:/Program Files/ffmpeg/bin/ffmpeg.exe"', "ffmpeg", exists)).toEqual(["C:/Program Files/ffmpeg/bin/ffmpeg.exe"]);
		expect(commandFromSetting("python -m yt_dlp", "yt-dlp", exists)).toEqual(["python", "-m", "yt_dlp"]);
		expect(commandFromSetting(undefined, "yt-dlp", exists)).toEqual(["yt-dlp"]);
	});
	test("playlist pages are refused; a video link with list= is one entry", () => {
		expect(isPlaylistOnly("https://www.youtube.com/playlist?list=PL123")).toBe(true);
		expect(isPlaylistOnly("https://www.youtube.com/watch?v=abc&list=PL123")).toBe(false);
	});
});
