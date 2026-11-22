"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { agentReadiness, agentRootScene, pollExport } from "@/agent/bridge";
import { pollFrames } from "@/agent/frames";
import { EditorCore } from "@/core";
import { mediaIdsInScenes } from "@/core/managers/media-manager";
import { collectAudibleCandidates } from "@/media/audio";
import { rendererDevice } from "@/services/renderer/renderer-device";
import { calculateTotalDuration } from "@/timeline";
import { isElementMuted } from "@/timeline/audio-state";

let started = false;

async function render(key: string) {
	const endpoint = "/api/agent/cli/render";
	const claimed = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`, { cache: "no-store" });
	const token = claimed.headers.get("x-bopencut-render-token");
	if (!claimed.ok || !token) return;
	const send = (action: string, body: object) => fetch(`${endpoint}?action=${action}`, {
		method: "POST", headers: { "Content-Type": "application/json", "x-bopencut-render-token": token }, body: JSON.stringify(body),
	});
	try {
		const kind = claimed.headers.get("x-bopencut-render-kind");
		const { projectId, includeAudio } = await claimed.clone().json();
		const editor = EditorCore.createRenderOnly();
		await editor.project.loadForRender(projectId, async () => { await send("stage", { stage: "loading media" }); });
		const scenes = editor.scenes.getScenes();
		const assets = editor.media.getAssets();
		const used = mediaIdsInScenes(scenes);
		if (assets.some((asset) => used.has(asset.id) && asset.file.type === "image/gif")) {
			throw new Error("This project uses GIF media. Open the editor to render it.");
		}
		const root = agentRootScene();
		if (root && kind === "export" && includeAudio !== false && collectAudibleCandidates({
			tracks: root.tracks, scenes, mediaAssets: assets, duration: calculateTotalDuration({ tracks: root.tracks }),
		}).some(({ element }) => element.type === "audio" && element.sourceType === "library" &&
			!isElementMuted({ element }) && !/^\/api\/agent\/(?:sfx|music)-file\?/.test(element.sourceUrl ?? ""))) {
			throw new Error("This project needs external audio retrieval. Open the editor to render it.");
		}
		await send("stage", { stage: "waiting for graphics" });
		await rendererDevice.start();
		if (rendererDevice.status.state !== "ready" || (kind === "export" && typeof VideoEncoder === "undefined")) {
			throw new Error("Graphics or video encoding is unavailable in the hidden browser. Open the editor once and retry.");
		}
		if (kind === "export") await pollExport(claimed);
		else await pollFrames(agentReadiness, claimed);
		await send("failure", { error: "The hidden browser could not finish the render. Open the editor once and retry." });
	} catch (error) {
		await send("failure", { error: error instanceof Error ? error.message : String(error) });
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
