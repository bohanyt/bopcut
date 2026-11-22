import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunner, runTool, toolsFromEnv } from "@/retrieval/server";
import { GIF_SOURCE_FPS_HEADER } from "@/media/media-utils";

function gcd(left: number, right: number): number {
	while (right) [left, right] = [right, left % right];
	return left;
}

export async function handleGif(request: Request): Promise<Response> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-gif-"));
	try {
		const input = path.join(dir, "in.gif");
		await fs.writeFile(input, Buffer.from(await request.arrayBuffer()));
		const { ffmpeg } = toolsFromEnv();
		const run = (args: string[]) => runTool(defaultRunner, ffmpeg, [
			"-hide_banner", "-loglevel", "error", "-nostdin", ...args,
		], "ffmpeg");
		const source = ["-f", "gif", "-i", input];
		// A GIF delta frame can declare transparency while the visible canvas stays opaque.
		// Select the first decoded frame with a transparent pixel in its binary alpha mask.
		const probe = await run([
			...source, "-an", "-vf",
			"alphaextract,format=yuv420p,signalstats,metadata=mode=select:key=lavfi.signalstats.YMIN:value=128:function=less",
			"-frames:v", "1", "-c:v", "rawvideo", "-f", "framecrc", "pipe:1",
		]);
		const alpha = /^\d+,/m.test(probe);
		const [, major, minor] = /^#software: Lavf(\d+)\.(\d+)/m.exec(probe) ?? [];
		const headers = new Headers({ "Content-Type": alpha ? "video/webm" : "video/mp4" });
		const filters = alpha ? [] : ["scale=trunc(iw/2)*2:trunc(ih/2)*2"];
		let loopedInput = ["-stream_loop", "2", ...source];
		let timing = ["-fps_mode", "passthrough", "-enc_time_base", "1:100"];
		if (major && Number(major) < 61) {
			// Older FFmpeg can estimate the wrong loop offset from the reported frame rate.
			// Supply each loop's exact duration from the GIF packet timestamps instead.
			const packets = await run([...source, "-an", "-c:v", "copy", "-f", "framecrc", "pipe:1"]);
			let duration = 0;
			let cadence = 0;
			let frameCount = 0;
			for (const [, pts, delay] of packets.matchAll(/^0,\s*\d+,\s*(\d+),\s*(\d+),/gm)) {
				duration = Number(pts) + Number(delay);
				cadence = gcd(cadence, Number(delay));
				frameCount++;
			}
			if (!duration || !cadence) throw new Error("GIF is missing frame timing");
			const escapedPath = input.split(path.sep).join("/").replaceAll("'", "'\\''");
			const entry = `file 'file:${escapedPath}'\nduration ${duration / 100}\n`;
			const playlist = Buffer.from("ffconcat version 1.0\n" + entry.repeat(3)).toString("base64");
			loopedInput = ["-f", "concat", "-safe", "0", "-protocol_whitelist", "file,data",
				"-i", `data:text/plain;base64,${playlist}`];
			if (Number(major) < 60 || Number(minor) < 16) {
				// Older muxers can lose the final hold. Use the slowest constant rate
				// that represents every GIF delay exactly.
				filters.push(`fps=100/${cadence}`);
				timing = [];
				headers.set(GIF_SOURCE_FPS_HEADER, String(frameCount * 100 / duration));
			}
		}
		const encoding = alpha
			? ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "18", "-deadline", "good", "-cpu-used", "4"]
			: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-bf", "0", "-movflags", "+faststart"];
		const output = path.join(dir, alpha ? "out.webm" : "out.mp4");
		await run([
			...loopedInput, "-an", ...encoding, ...(filters.length ? ["-vf", filters.join(",")] : []),
			...timing, output,
		]);
		return new Response(new Uint8Array(await fs.readFile(output)), { headers });
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}
