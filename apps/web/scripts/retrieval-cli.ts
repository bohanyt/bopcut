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
	try {
		const result = await work(controller.signal);
		console.log(JSON.stringify(result.body, null, 1));
		process.exitCode = result.status === 200 ? 0 : 1;
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}
