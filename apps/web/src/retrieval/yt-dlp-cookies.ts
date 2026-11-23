import { promises as fs } from "node:fs";
import path from "node:path";
import { checkCancelled } from "./jobs";
import { RetrievalError } from "./server-errors";

export const cookiePluginFile = "job-plugin/yt_dlp_plugins/postprocessor/bopencut_job_cookies.py";

// A required postprocessor receives yt-dlp's parsed options, including aliases and config files.
// Its constructor runs before extraction. An already loaded cookie jar keeps its in-memory cookies.
export const cookiePlugin = `
import json
import os
import shutil
import stat

from yt_dlp.postprocessor.common import PostProcessor
from yt_dlp.utils import expand_path


class BopencutJobCookiesPP(PostProcessor):
    def __init__(self, downloader):
        super().__init__(downloader)
        scratch = os.environ["TMPDIR"]
        source = downloader.params.get("cookiefile")
        state = "copy" if source is not None else "none"
        with open(os.path.join(scratch, "cookie-state"), "x", encoding="ascii") as marker:
            marker.write(state)
        if source is None:
            return

        # Paths in the user's config resolve against the original environment.
        original_temp = json.loads(os.environ["BOPENCUT_TOOL_ORIGINAL_TEMP"])
        try:
            for name, value in original_temp.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
            source = expand_path(source)
        finally:
            for name in original_temp:
                os.environ[name] = scratch
        copy = os.path.join(scratch, "cookies.txt")
        try:
            mode = os.stat(source).st_mode
        except FileNotFoundError:
            pass
        else:
            if not stat.S_ISREG(mode):
                raise ValueError("expected a regular cookie file")
            with open(source, "rb") as original, open(copy, "xb") as private:
                shutil.copyfileobj(original, private)
        downloader.params["cookiefile"] = copy
        jar = downloader.__dict__.get("cookiejar")
        if jar is not None:
            jar.filename = copy
`;

type ToolOutput = { stdout: string; stderr: string };

export async function runWithPrivateCookies(
	args: string[], scratch: string, signal: AbortSignal, run: (args: string[]) => Promise<ToolOutput>,
): Promise<ToolOutput> {
	const separator = args.lastIndexOf("--");
	const index = separator === -1 ? args.length : separator;
	const options = [
		...(process.env.YTDLP_NO_PLUGINS ? ["--no-plugin-dirs"] : []),
		"--plugin-dirs", scratch, "--use-postprocessor", "BopencutJobCookies",
	];
	const state = () => fs.readFile(path.join(scratch, "cookie-state"), "utf8").catch(() => undefined);
	try {
		const output = await run([...args.slice(0, index), ...options, ...args.slice(index)]);
		return await state() === "none" ? output : { stdout: output.stdout, stderr: "" };
	} catch (error) {
		checkCancelled(signal, "yt-dlp");
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
		// Malformed cookie entries and debug traffic can include credential values.
		const configured = await state();
		if (configured === "none") throw error;
		if (configured === "copy") throw new RetrievalError("yt-dlp failed while using the private cookie copy");
		throw new RetrievalError("yt-dlp failed to initialize private cookies; check its configuration and version");
	}
}
