import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { POST } from "@/app/api/agent/[...slug]/route";
import * as retrieval from "@/retrieval/server";

test.each([
	["video/webm", "#software: Lavf\n0, 0, 0, 1, 1, 0x00000000\n", "libvpx-vp9", "yuva420p"],
	["video/mp4", "#software: Lavf\n", "libx264", "yuv420p"],
])("GIF conversion returns %s with the configured ffmpeg", async (mime, probe, codec, pixelFormat) => {
	const originalFfmpeg = process.env.BOPENCUT_FFMPEG;
	process.env.BOPENCUT_FFMPEG = '"custom ffmpeg" --configured';
	let directory: string | undefined;
	const runner = spyOn(retrieval, "defaultRunner").mockImplementation(async (command, args) => {
		expect(command).toBe("custom ffmpeg");
		expect(args[0]).toBe("--configured");
		const input = args[args.indexOf("-i") + 1];
		directory = dirname(input);
		expect(readFileSync(input, "utf8")).toBe("GIF bytes");
		if (args.includes("framecrc")) {
			expect(args[args.indexOf("-vf") + 1]).toContain("lavfi.signalstats.YMIN:value=128:function=less");
			return { stdout: probe, stderr: "" };
		}
		expect(args).toContain(codec);
		expect(args).toContain(pixelFormat);
		if (mime === "video/mp4") expect(args[args.indexOf("-bf") + 1]).toBe("0");
		expect(args[args.indexOf("-stream_loop") + 1]).toBe("2");
		expect(args[args.indexOf("-fps_mode") + 1]).toBe("passthrough");
		expect(args[args.indexOf("-enc_time_base") + 1]).toBe("1:100");
		writeFileSync(args.at(-1)!, "converted");
		return { stdout: "", stderr: "" };
	});
	try {
		const response = await POST(new Request("http://localhost/api/agent/gif", { method: "POST", body: "GIF bytes" }), {
			params: Promise.resolve({ slug: ["gif"] }),
		});
		expect(response.headers.get("Content-Type")).toBe(mime);
		expect(await response.text()).toBe("converted");
		expect(runner).toHaveBeenCalledTimes(2);
		expect(directory).toBeDefined();
		expect(existsSync(directory!)).toBe(false);
	} finally {
		runner.mockRestore();
		if (originalFfmpeg === undefined) delete process.env.BOPENCUT_FFMPEG;
		else process.env.BOPENCUT_FFMPEG = originalFfmpeg;
	}
});

test.each([
	["58.29.100", true, "video/webm"],
	["58.29.100", false, "video/mp4"],
	["60.16.100", true, "video/webm"],
] as const)("FFmpeg Lavf%s preserves three GIF loops (alpha: %p)", async (version, alpha, mime) => {
	let commands = 0;
	const runner = spyOn(retrieval, "defaultRunner").mockImplementation(async (_command, args) => {
		commands++;
		if (args.includes("rawvideo")) {
			return { stdout: `#software: Lavf${version}\n${alpha ? "0, 8, 8, 24, 42, 0x00000000\n" : ""}`, stderr: "" };
		}
		if (args.includes("framecrc")) {
			expect(args).toContain("copy");
			return { stdout: "#tb 0: 1/100\n0, 0, 0, 8, 42, 0x00000000\n0, 8, 8, 24, 42, 0x00000000\n0, 32, 32, 48, 42, 0x00000000\n", stderr: "" };
		}
		expect(args).not.toContain("-stream_loop");
		const input = args[args.indexOf("-i") + 1];
		const concat = Buffer.from(input.split(",")[1], "base64").toString("utf8");
		expect(concat.match(/duration 0\.8/g)).toHaveLength(3);
		expect(concat.match(/in\.gif/g)).toHaveLength(3);
		if (version.startsWith("58.")) {
			expect(args).not.toContain("-fps_mode");
			expect(args[args.indexOf("-vf") + 1]).toContain("fps=100/8");
		} else {
			expect(args).toContain("-fps_mode");
		}
		expect(args).toContain(alpha ? "yuva420p" : "yuv420p");
		writeFileSync(args.at(-1)!, "converted");
		return { stdout: "", stderr: "" };
	});
	try {
		const response = await POST(new Request("http://localhost/api/agent/gif", { method: "POST", body: "GIF bytes" }), {
			params: Promise.resolve({ slug: ["gif"] }),
		});
		expect(response.headers.get("Content-Type")).toBe(mime);
		expect(await response.text()).toBe("converted");
		expect(commands).toBe(3);
		expect(response.headers.get("X-Bopencut-GIF-FPS")).toBe(version.startsWith("58.") ? "3.75" : null);
	} finally {
		runner.mockRestore();
	}
});
