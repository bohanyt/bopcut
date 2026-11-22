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
			expect(args).toContain("alphaextract,negate,bbox=min_val=1,metadata=mode=select:key=lavfi.bbox.w");
			return { stdout: probe, stderr: "" };
		}
		expect(args).toContain(codec);
		expect(args).toContain(pixelFormat);
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
