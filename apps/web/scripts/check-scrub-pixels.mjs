// Run from apps/web with bun scripts/check-scrub-pixels.mjs <Edge or Chromium executable>.
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const executable = process.argv[2];
if (!executable) throw new Error("Pass an Edge or Chromium executable path");
const wasmDir = dirname(createRequire(import.meta.url).resolve("opencut-wasm"));
const temp = await realpath(tmpdir());
const profile = await mkdtemp(join(temp, "scrub-pixels-"));
let server, browser, socket;
try {
	const bundle = await Bun.build({
		entrypoints: [join(import.meta.dir, "scrub-pixels.browser.ts")],
		format: "esm",
		target: "browser",
		tsconfig: join(import.meta.dir, "../tsconfig.json"),
		plugins: [{
			name: "browser-wasm",
			setup(build) {
				build.onLoad({ filter: /opencut_wasm\.js$/ }, () => ({
					loader: "js",
					resolveDir: wasmDir,
					contents: `
						import * as bg from "./opencut_wasm_bg.js";
						const {instance}=await WebAssembly.instantiateStreaming(fetch("/renderer.wasm"),{"./opencut_wasm_bg.js":bg});
						bg.__wbg_set_wasm(instance.exports);
						instance.exports.__wbindgen_start();
						export * from "./opencut_wasm_bg.js";
					`,
				}));
			},
		}],
	});
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			switch (new URL(request.url).pathname) {
				case "/":
					return new Response(`<body><script>
						addEventListener("error", (event) => document.body.dataset.result = JSON.stringify({error: event.message}));
					</script><script type="module" src="/test.js"></script>`, { headers: { "content-type": "text/html" } });
				case "/test.js":
					return new Response(bundle.outputs[0], { headers: { "content-type": "text/javascript" } });
				case "/renderer.wasm":
					return new Response(Bun.file(join(wasmDir, "opencut_wasm_bg.wasm")), { headers: { "content-type": "application/wasm" } });
				default:
					return new Response(null, { status: 404 });
			}
		},
	});
	browser = Bun.spawn([
		executable, "--headless=new", "--force_high_performance_gpu", "--disable-features=msEdgeFre,msEdgeFirstRunExperience",
		"--no-first-run", "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank",
	], { stdout: "ignore", stderr: "ignore", windowsHide: true });
	let port;
	for (let attempt = 0; attempt < 60; attempt++) {
		try {
			port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
			if (port) break;
		} catch {
			await Bun.sleep(100);
		}
	}
	if (!port) throw new Error("Browser CDP did not become available");
	const [tab] = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
		.filter((target) => target.url === "about:blank");
	if (!tab) throw new Error("Could not find the test tab");
	socket = new WebSocket(tab.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let id = 0;
	const pending = new Map();
	socket.onmessage = ({ data }) => {
		const result = JSON.parse(data);
		pending.get(result.id)?.(result);
		pending.delete(result.id);
	};
	const call = (method, params) => new Promise((resolve, reject) => {
		const next = ++id;
		const timeout = setTimeout(() => { pending.delete(next); reject(new Error(method + " timed out")); }, 5000);
		pending.set(next, ({ error, result }) => {
			clearTimeout(timeout);
			if (error) reject(new Error(error.message));
			else resolve(result);
		});
		socket.send(JSON.stringify({ method, params, id: next }));
	});
	await call("Page.navigate", { url: server.url.href });
	let result;
	for (let attempt = 0; attempt < 240; attempt++) {
		const evaluation = await call("Runtime.evaluate", {
			expression: "document.body?.dataset.result",
			returnByValue: true,
		});
		if (evaluation.result.value) {
			result = JSON.parse(evaluation.result.value);
			break;
		}
		await Bun.sleep(100);
	}
	await call("Browser.close").catch(() => {});
	if (!result || result.error) throw new Error(result?.error ?? "Pixel comparison timed out");
	console.log("Renderer adapter", result.adapter);
	console.table(result.results);
	if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
} finally {
	socket?.close();
	server?.stop(true);
	if (browser && browser.exitCode === null) browser.kill();
	await browser?.exited;
	const resolved = await realpath(profile);
	if (dirname(resolved) !== temp) throw new Error("Unexpected browser profile path");
	await rm(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
}
