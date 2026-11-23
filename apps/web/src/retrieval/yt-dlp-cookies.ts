import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { checkCancelled } from "./jobs";
import { RetrievalError } from "./server-errors";

type ToolOutput = { stdout: string; stderr: string };
const configProbe = ["--verbose", "--no-cookies", "--help"];

// yt-dlp prints one Python list per loaded config, highest priority first.
// Decode string literals as data. The listing can contain private headers.
function configArguments(list: string): string[] {
	const args: string[] = [];
	const literal = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/gy;
	const escapes: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', n: "\n", r: "\r", t: "\t" };
	let offset = 1;
	while (offset < list.length - 1) {
		literal.lastIndex = offset;
		const match = literal.exec(list);
		if (!match) throw new RetrievalError("could not read yt-dlp's configuration");
		args.push((match[1] ?? match[2]).replace(/\\(?:x([\da-fA-F]{2})|u([\da-fA-F]{4})|U([\da-fA-F]{8})|(.))/g,
			(_, byte, word, point, char) => byte || word || point
				? String.fromCodePoint(Number.parseInt(byte ?? word ?? point, 16))
				: escapes[char] ?? char));
		offset = literal.lastIndex;
		if (list.startsWith(", ", offset)) offset += 2;
		else if (offset !== list.length - 1) throw new RetrievalError("could not read yt-dlp's configuration");
	}
	return args;
}

function configuredCookieFile(stderr: string): string | undefined {
	const lines = stderr.split(/\r?\n/);
	const commandLine = lines.findIndex((line) => /^\[debug\] Command-line config: \[/.test(line));
	if (commandLine < 0) throw new RetrievalError("could not read yt-dlp's configuration");
	for (let index = commandLine; index < lines.length; index++) {
		const line = lines[index];
		const entry = /^\[debug\] (?:\| )*(?:\w[\w-]* )?[Cc]onfig(?: ".*")?: (\[.*\])$/.exec(line);
		if (!entry) break;
		const args = configArguments(entry[1]);
		if (index === commandLine) {
			const probe = args.splice(-configProbe.length);
			if (!configProbe.every((flag, i) => probe[i] === flag)) throw new RetrievalError("could not read yt-dlp's configuration");
		}
		let cookieFile: string | null | undefined;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "--") break;
			if (arg === "--cookies") cookieFile = args[++i];
			else if (arg.startsWith("--cookies=")) cookieFile = arg.slice("--cookies=".length);
			else if (arg === "--no-cookies") cookieFile = null;
		}
		if (cookieFile !== undefined) return cookieFile ?? undefined;
	}
	return undefined;
}

function expandCookiePath(file: string) {
	const expandedHome = file.replace(process.platform === "win32" ? /^~(?=$|[/\\])/ : /^~(?=$|\/)/, homedir);
	const vars = process.platform === "win32" ? /\$(\w+)|\$\{([^}]+)\}|%([^%]+)%/g : /\$([\w-]+)|\$\{([^}]+)\}/g;
	return expandedHome.replace(vars, (token, bare, braced, percent) => process.env[bare ?? braced ?? percent] ?? token);
}

export async function withCookieCopy(
	args: string[], scratch: string, signal: AbortSignal, run: (args: string[]) => Promise<ToolOutput>,
): Promise<ToolOutput> {
	const separator = args.lastIndexOf("--");
	const options = separator < 0 ? args : args.slice(0, separator);
	const urls = separator < 0 ? [] : args.slice(separator);
	// Help exits after parsing config, before loading cookies, running extractors or opening a URL.
	const config = await run([...options, ...configProbe]).catch((error: NodeJS.ErrnoException) => {
		checkCancelled(signal, "yt-dlp configuration");
		if (error.code === "ENOENT") throw error;
		throw new RetrievalError("could not read yt-dlp's configuration");
	});
	const file = configuredCookieFile(config.stderr);
	const cookieArgs = ["--no-cookies"];
	if (file) {
		const source = expandCookiePath(file);
		const copy = path.join(scratch, "cookies.txt");
		try {
			const stat = await fs.stat(source).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			if (stat) {
				if (!stat.isFile()) throw new Error("expected a regular file");
				await pipeline(createReadStream(source), createWriteStream(copy, { flags: "wx", mode: 0o600 }), { signal });
			}
		} catch {
			checkCancelled(signal, "copying yt-dlp cookies");
			throw new RetrievalError("could not copy the configured yt-dlp cookie file");
		}
		cookieArgs.push("--cookies", copy);
	}
	// Always override the cookie destination, including if config changed since the probe.
	try {
		const result = await run([...options, ...cookieArgs, ...urls]);
		return file ? { stdout: result.stdout, stderr: "" } : result;
	} catch (error) {
		checkCancelled(signal, "yt-dlp");
		// Tool diagnostics may contain cookie values, including malformed cookie file lines.
		if (file) throw new RetrievalError("yt-dlp failed while using the private cookie copy");
		throw error;
	}
}
