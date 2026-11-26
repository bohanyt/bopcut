"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { importAgentBundle } from "./importer";

/** Imports the agent's bundle as a new project and opens it; used by /agent and the home page. */
export function useBundleImport() {
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
	return { run, status, errorDetail, busy };
}
