"use client";

import { localizeErrorDetail } from "@/i18n/error-details";

import { useI18n } from "@/i18n/provider";

// Open /agent to load an agent draft (AGENT_WORKSPACE/bundle) as a new OpenCut project.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { importAgentBundle } from "@/agent/importer";

export default function AgentImport() {
	const { t } = useI18n();
	const router = useRouter();
	const [status, setStatus] = useState("");
	const [errorDetail, setErrorDetail] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		setErrorDetail(null);
		try {
			const id = await importAgentBundle({ onStatus: setStatus });
			router.push(`/editor/${id}`);
		} catch (error) {
			setStatus("");
			setErrorDetail(error instanceof Error ? error.message : String(error));
			setBusy(false);
		}
	};
	return (
		<div className="bg-background flex h-screen w-screen flex-col items-center justify-center gap-4">
			<h1 className="text-2xl font-semibold">{t("agentImport.title")}</h1>
			<p className="text-muted-foreground max-w-md text-center text-sm">
				{t("agentImport.intro")}
			</p>
			<button type="button" disabled={busy} onClick={run} className="bg-primary text-primary-foreground rounded-md px-5 py-2 font-medium disabled:opacity-50">
				{busy ? t("agentImport.busy") : t("agentImport.action")}
			</button>
			<p className="text-muted-foreground text-sm" role="status">
				{errorDetail === null ? status : t("agentImport.failed")}
			</p>
			{errorDetail !== null && (
				<details className="text-muted-foreground max-w-md break-words text-sm">
					<summary className="cursor-pointer">{t("common.errorDetails")}</summary>
					<p>{localizeErrorDetail(errorDetail, t)}</p>
				</details>
			)}
		</div>
	);
}
