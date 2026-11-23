import { existsSync, readFileSync } from "node:fs";

export function loadEnvLocal(file: string) {
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m || line.trim().startsWith("#")) continue;
		const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
		if (process.env[m[1]] === undefined) process.env[m[1]] = value;
	}
}

export function retrievalOptions(args: string[], usage: (message: string) => never) {
	const at = args.indexOf("--timeout");
	if (at < 0) return { args, timeout: undefined };
	const seconds = Number(args[at + 1]);
	if (!(seconds > 0 && seconds <= 2_147_483)) usage("--timeout needs a positive number of seconds");
	return { args: [...args.slice(0, at), ...args.slice(at + 2)], timeout: Math.ceil(seconds * 1000) };
}

export async function runRetrievalCli(
	timeout: number | undefined,
	work: (signal: AbortSignal) => Promise<{ status: number; body: unknown }>,
) {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	const timer = timeout === undefined ? undefined : setTimeout(cancel, timeout);
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	let status: number;
	try {
		const result = await work(controller.signal);
		console.log(JSON.stringify(result.body, null, 1));
		status = result.status;
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
	process.exit(status === 200 ? 0 : 1);
}
