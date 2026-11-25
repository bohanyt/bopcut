import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DraftThresholds } from "../src/agent/draft-check";
import type { PictureOptions } from "../src/agent/draft-check-pictures";
import { loadEnvLocal } from "./retrieval-cli";

async function loadTimeline() {
	// The package's browser entry expects a bundler to instantiate its WASM import.
	const entry = import.meta.resolve("opencut-wasm");
	const glue = await import(new URL("./opencut_wasm_bg.js", entry).href);
	const module = new WebAssembly.Module(await readFile(new URL("./opencut_wasm_bg.wasm", entry)));
	const instance = new WebAssembly.Instance(module, { "./opencut_wasm_bg.js": glue });
	glue.__wbg_set_wasm(instance.exports);
	(instance.exports.__wbindgen_start as () => void)();
	Bun.plugin({ name: "opencut-wasm", setup: (build) => {
		build.module("opencut-wasm", () => ({ exports: glue, loader: "object" }));
	} });
	return Promise.all([import("../src/agent/draft-check"), import("../src/agent/transcript-view-server"),
		import("../src/timeline"), import("../src/wasm")]);
}
let timeline: ReturnType<typeof loadTimeline> | undefined;

export async function draftCheckCommand(options: {
	projectId: string; from: number; to?: number; json: boolean; all: boolean; thresholds: Partial<DraftThresholds>; timeoutMs: number;
	pictures?: Partial<PictureOptions>;
}) {
	const started = performance.now();
	const webDir = path.resolve(import.meta.dir, "..");
	loadEnvLocal(path.join(webDir, ".env.local"));
	const directory = path.resolve(webDir, process.env.BOPENCUT_DATA ?? "../../workspace", "projects", options.projectId);
	const signal = AbortSignal.timeout(options.timeoutMs);
	const [{ draftThresholds, formatDraftReport, inspectDraft }, { readReviewableProject }, { calculateTotalDuration }, { TICKS_PER_SECOND }] =
		await (timeline ??= loadTimeline());
	const { project, root, scenes, media } = await readReviewableProject(options.projectId, signal, { includeStaged: false, directory });
	if (!root) throw new Error("No timeline was saved for this project.");
	const duration = calculateTotalDuration({ tracks: root.tracks }) / TICKS_PER_SECOND;
	const to = options.to ?? duration;
	// Allow the decimal representation of the final tick.
	const rangeEnd = Math.round(to * TICKS_PER_SECOND);
	const rangeStart = Math.round(options.from * TICKS_PER_SECOND);
	if (rangeEnd > Math.round(duration * TICKS_PER_SECOND) || rangeStart > rangeEnd ||
		(rangeStart === rangeEnd && (duration > 0 || options.from !== 0 || options.to !== undefined))) {
		throw new Error(`Choose a nonempty range within the saved timeline (0 to ${duration.toFixed(6)} seconds).`);
	}
	const { canvasSize, fps = { numerator: 30, denominator: 1 } } = project.settings;
	if (!canvasSize || ![canvasSize.width, canvasSize.height, fps.numerator, fps.denominator].every(value => Number.isFinite(value) && value > 0)) {
		throw new Error("The saved canvas size or frame rate is invalid.");
	}
	const report = inspectDraft({ root, scenes, media, canvas: canvasSize, fps: fps.numerator / fps.denominator,
		from: options.from, to, thresholds: { ...draftThresholds, ...options.thresholds }, signal });
	if (!options.pictures) return formatDraftReport(report, options.json, options.all);
	const interrupt = new AbortController();
	const stop = () => interrupt.abort(new Error("Draft check interrupted."));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		const { inspectDraftPictures, pictureDefaults } = await import("../src/agent/draft-check-pictures");
		const pictures = await inspectDraftPictures({ root, scenes, media, directory, from: options.from, to,
			options: { ...pictureDefaults, ...options.pictures }, signal: AbortSignal.any([signal, interrupt.signal]),
			budgetMs: Math.max(1, Math.floor(options.timeoutMs - (performance.now() - started) - 1_000)) });
		return formatDraftReport(report, options.json, options.all, pictures);
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}
