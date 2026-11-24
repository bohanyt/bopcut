"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { agentReadiness, agentRootScene, pollExport } from "@/agent/bridge";
import { pollFrames } from "@/agent/frames";
import { renderRangeView } from "@/agent/range-view-worker";
import { renderAdapterStage, renderGpuWorkaround } from "@/agent/render-gpu";
import { waitingForGraphics } from "@/agent/render-timeout";
import { renderTransport } from "@/agent/render-transport";
import { EditorCore } from "@/core";
import { mediaIdsInScenes } from "@/core/managers/media-manager";
import { collectAudibleCandidates } from "@/media/audio";
import { getRendererAdapter, rendererDevice } from "@/services/renderer/renderer-device";
import { calculateTotalDuration } from "@/timeline";
import { isElementMuted } from "@/timeline/audio-state";

let started = false;

async function render(key: string) {
	const endpoint = "/api/agent/cli/render";
	const claimed = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`, { cache: "no-store" });
	if (!claimed.ok || !claimed.headers.has("x-bopencut-render-token")) return;
	const job = renderTransport(claimed);
	const send = (action: string, body: object, signal?: AbortSignal) => job.request(`/api/agent/${action}`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
	});
	try {
		const kind = claimed.headers.get("x-bopencut-render-kind");
		const options = await claimed.clone().json();
		const { projectId, includeAudio } = options;
		const editor = EditorCore.createRenderOnly();
		await editor.project.loadForRender(projectId, async () => { await send("stage", { stage: "loading media" }); });
		const scenes = editor.scenes.getScenes();
		const assets = editor.media.getAssets();
		const used = mediaIdsInScenes(scenes);
		if (assets.some((asset) => used.has(asset.id) && asset.file.type === "image/gif")) {
			throw new Error("This project uses GIF media. Open the editor to render it.");
		}
		const root = agentRootScene();
		if (root && (kind === "export" || kind === "view") && includeAudio !== false && collectAudibleCandidates({
			tracks: root.tracks, scenes, mediaAssets: assets, duration: calculateTotalDuration({ tracks: root.tracks }),
		}).some(({ element }) => element.type === "audio" && element.sourceType === "library" &&
			!isElementMuted({ element }) && !/^\/api\/agent\/(?:sfx|music)-file\?/.test(element.sourceUrl ?? ""))) {
			throw new Error("This project needs external audio retrieval. Open the editor to render it.");
		}
		await send("stage", { stage: waitingForGraphics });
		await rendererDevice.start();
		const graphicsReady = rendererDevice.status.state === "ready";
		if (!graphicsReady || (kind === "export" && typeof VideoEncoder === "undefined")) {
			const error = "Graphics or video encoding is unavailable in the hidden browser. Open the editor once and retry.";
			throw new Error(graphicsReady ? error : `${error} ${renderGpuWorkaround}`);
		}
		const stage = renderAdapterStage(await getRendererAdapter());
		await send("stage", { stage }, AbortSignal.timeout(1000)).catch(() => { /* Render even if reporting fails. */ });
		if (kind === "view") return await renderRangeView(options, job);
		if (kind === "export") await pollExport(claimed, job);
		else await pollFrames(agentReadiness, claimed, job);
		if (!job.signal?.aborted) await send("failure", { error: "The hidden browser could not finish the render. Open the editor once and retry." });
	} catch (error) {
		if (!job.signal?.aborted) await send("failure", { error: error instanceof Error ? error.message : String(error) });
	}
}

export default function RenderPage() {
	const { key } = useParams<{ key: string }>();
	useEffect(() => {
		if (started || !key) return;
		started = true;
		void render(key).catch(console.error);
	}, [key]);
	return null;
}
