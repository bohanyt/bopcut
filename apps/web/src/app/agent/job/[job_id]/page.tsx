"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { agentSnapshot, runEditorJob } from "@/agent/bridge";
import { claimHiddenJob, runClaimedJob } from "@/agent/cli-browser";
import { setHiddenStorageJob } from "@/agent/cli-transport";
import { EditorCore } from "@/core";
import { rendererDevice } from "@/services/renderer/renderer-device";

let started = false;

async function work(id: string) {
	const claimed = await claimHiddenJob(id);
	if (!claimed) return;
	await runClaimedJob(claimed, true, async (job) => {
		setHiddenStorageJob(id);
		const editor = EditorCore.getInstance();
		const unsubscribe = editor.project.subscribe(() => {
			if (editor.project.getActiveOrNull()?.metadata.id === claimed.projectId) void job.progress("loading media").catch(() => {});
		});
		try {
			await editor.project.loadProject({ id: claimed.projectId });
		} finally {
			unsubscribe();
		}
		job.signal.throwIfAborted();
		if (claimed.command === "frames" || claimed.command === "export") {
			await job.progress("waiting for graphics");
			await rendererDevice.start();
			const graphics = rendererDevice.status;
			if (graphics.state !== "ready") throw new Error("The hidden browser could not start graphics. Open the project in the editor once and retry.");
		}
		await runEditorJob(claimed, {
			...job,
			async publishSnapshot() {
				const snapshot = agentSnapshot();
				if (!snapshot) return;
				await job.request("/api/agent/sync", {
					method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot),
				});
			},
		});
	});
}

export default function JobPage() {
	const { job_id } = useParams<{ job_id: string }>();
	useEffect(() => {
		if (started || !job_id) return;
		started = true;
		void work(job_id).catch((error) => console.error("Agent job failed:", error));
	}, [job_id]);
	return null;
}
