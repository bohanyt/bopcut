import { promises as fs } from "node:fs";
import path from "node:path";
import { projectDir, readJson } from "@/services/storage/server/files";
import { fileInside } from "./inside";
import { isForeignOrigin } from "./origin";
import { isCliRenderRunning, isProjectOpen, startRender } from "./render-server";
import { reserveEditorActivity, reserveReview } from "./review-activity";
import { readSilencePlan, readTranscriptView } from "./transcript-view-server";
import { DEFAULT_SILENCE_OPTIONS } from "./silence-plan";

type Snapshot = { projectId?: string; notes?: unknown; syncedAt?: string };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

const readInside = async (root: string, ...parts: string[]) => {
	const file = await fileInside(root, ...parts);
	return file ? readJson(file) : null;
};

/** A snapshot that is not valid JSON counts as missing here, so the other snapshot can answer. Links still fail. */
async function readSnapshot(workspace: string, ...parts: string[]): Promise<Snapshot | null> {
	try { return await readInside(workspace, ...parts); }
	catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
}

export async function handleCli(req: Request, action: string, workspace: string): Promise<Response> {
	const url = new URL(req.url);
	if (action === "activity" && req.method === "POST" && !isForeignOrigin(req) && req.headers.get("sec-fetch-site") !== "cross-site") {
		return reserveEditorActivity(req.signal);
	}
	if (!["localhost", "127.0.0.1"].includes(url.hostname) || isForeignOrigin(req) || req.headers.get("sec-fetch-site") === "cross-site") {
		return json({ error: "Use the agent CLI on the local editor server." }, 403);
	}
	const requested = url.searchParams.get("projectId");
	if (requested !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(requested)) {
		return json({ error: "Pass a valid --project-id or open a project in the editor." }, 400);
	}
	if (action === "presence" && req.method === "GET") {
		if (!requested) return json({ error: "Pass a projectId." }, 400);
		return json({ projectId: requested, open: isProjectOpen(requested) });
	}
	try {
		if (action === "review" && req.method === "POST") {
			const options = await req.json();
			if (!requested || typeof options?.file !== "string" || !options.file || typeof options.pictures !== "boolean" ||
				(options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 86400000))) {
				return json({ error: "Use review --project-id ID --file PATH [--pictures none]." }, 400);
			}
			const release = reserveReview(isCliRenderRunning());
			if (!release) return json({ error: "Wait until the recording, export, or other review has finished." }, 409);
			try {
				const { writeReview } = await import("./review-server");
				return json(await writeReview({ projectId: requested, relative: options.file, pictures: options.pictures,
					timeoutMs: options.timeoutMs, workspace, filesRoot: path.resolve(process.env.AGENT_FILES_ROOT ?? workspace), signal: req.signal }));
			} catch (error) {
				return json({ error: error instanceof Error ? error.message : "Could not review the export." }, 400);
			} finally { release(); }
		}
		if (action === "transcript-view" && req.method === "GET") {
			if (!requested) return json({ error: "Pass --project-id for a transcript view." }, 400);
			try {
				const result = await readTranscriptView(requested, url.searchParams.get("media"), req.signal);
				return new Response(result, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
			} catch (error) {
				return json({ error: error instanceof Error ? error.message : "Could not read the saved transcript." }, 400);
			}
		}
		if (action === "silence-plan" && req.method === "GET") {
			const usage = "Use silence-plan --project-id ID [--min-gap SECONDS] [--pad SECONDS] [--keep-fillers] [--keep-lead] [--tail] [--ignore-media NAME,...].";
			const number = (key: string, fallback: number, min: number, max: number) => {
				const value = url.searchParams.get(key);
				const parsed = value === null ? fallback : value.trim() ? Number(value) : NaN;
				return parsed >= min && parsed <= max ? parsed : NaN;
			};
			const minGap = number("minGap", DEFAULT_SILENCE_OPTIONS.minGap, 0.05, 10);
			const pad = number("pad", DEFAULT_SILENCE_OPTIONS.pad, 0, 1);
			const ignore = (url.searchParams.get("ignore") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
			if (!requested || !Number.isFinite(minGap) || !Number.isFinite(pad) || ignore.length > 50) return json({ error: usage }, 400);
			try {
				return json(await readSilencePlan(requested, {
					minGap, pad, ignoreMedia: ignore,
					fillers: url.searchParams.get("fillers") !== "0",
					lead: url.searchParams.get("lead") !== "0",
					tail: url.searchParams.get("tail") === "1",
				}, req.signal));
			} catch (error) {
				return json({ error: error instanceof Error ? error.message : "Could not plan the silence cuts." }, 400);
			}
		}
		if (action === "narration-plan" && req.method === "GET") {
			const clipId = url.searchParams.get("clip") ?? "", mediaId = url.searchParams.get("newMedia") ?? "";
			const timeoutMs = Number(url.searchParams.get("timeoutMs") ?? 30_000);
			const readTime = (key: string, defaultValue: number) => {
				const value = url.searchParams.get(key);
				return value === null ? defaultValue : value.trim() && Number.isFinite(Number(value)) ? Number(value) : NaN;
			};
			const from = readTime("from", 0), to = readTime("to", Infinity);
			if (!(from >= 0 && to > from)) return json({ error: "Use nonnegative root seconds and an end after the start for --from and --to." }, 400);
			if (!requested || !/^[\w-]{1,128}$/.test(clipId) || !/^[\w-]{1,128}$/.test(mediaId) ||
				!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
				return json({ error: "Use narration-plan --project-id ID --clip CLIP_ID --new-media MEDIA_ID [--json]." }, 400);
			}
			try {
				const { readNarrationPlan, formatNarrationPlan } = await import("./narration-plan-server");
				const signal = AbortSignal.any([req.signal, AbortSignal.timeout(timeoutMs)]);
				const plan = await readNarrationPlan({ projectId: requested, clipId, mediaId, timeoutMs, signal,
					from, to, includeUnchanged: url.searchParams.get("all") === "1" });
				return url.searchParams.get("format") === "json" ? json(plan) : new Response(formatNarrationPlan(plan),
					{ headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
			} catch (error) {
				return json({ error: error instanceof Error ? error.message : "Could not plan narration replacement." }, 400);
			}
		}
		if (action === "selection") {
			const selected = await readInside(workspace, "selection.json");
			return json({ selection: !requested || requested === selected?.projectId ? selected : null });
		}
		if (action === "render" && req.method === "POST") {
			return startRender(req, workspace, async () => {
				const projectId = requested ?? (await readSnapshot(workspace, "project.json"))?.projectId;
				if (!projectId || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) throw new Error("No project has synced yet. Pass --project-id or open the project in the editor.");
				await fs.access(path.join(projectDir(projectId), "project.json")).catch(() => {
					throw new Error("Project was not found on disk. Pass a valid --project-id.");
				});
				return projectId;
			});
		}
		if (action === "status" || action === "notes") {
			// A plain request answers from the last synced snapshot. A chosen project reads its own snapshot
			// first and falls back to the last synced one when that is the same project.
			const latest: Snapshot | null = requested ? null : await readSnapshot(workspace, "project.json");
			const projectId = requested ?? latest?.projectId;
			if (!projectId || !/^[a-zA-Z0-9_-]{1,128}$/.test(projectId)) {
				return json({ error: "No project has synced yet. Open a project in the editor, or pass --project-id, and retry." }, 404);
			}
			try { await fs.access(path.join(projectDir(projectId), "project.json")); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return json({ error: "Project was not found on disk. Open it in the editor or pass a valid --project-id." }, 404);
			}
			let snapshot = latest;
			if (requested) {
				const own = await readSnapshot(workspace, "sync", projectId.replaceAll("_", "") + ".json");
				const found = own?.projectId === projectId ? own : await readSnapshot(workspace, "project.json");
				snapshot = found?.projectId === projectId ? found : null;
			}
			return json(action === "status"
				? { projectId, snapshot }
				: { projectId, notes: snapshot?.notes ?? [], syncedAt: snapshot?.syncedAt ?? null });
		}
	} catch {
		return json({ error: "Could not read editor data. Check that the workspace files are readable and retry." }, 500);
	}
	return json({ error: "Use status, selection, or notes." }, 404);
}
