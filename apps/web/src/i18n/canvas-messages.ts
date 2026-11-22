import type { CanvasSizeIssue } from "@/services/renderer/renderer-device";
import type { createTranslator } from "./translate";

export function getCanvasIssueMessage(issue: CanvasSizeIssue, t: ReturnType<typeof createTranslator>) {
	if (issue.kind === "canvasInvalid") return t("settings.canvasInvalid");
	const { width, height, max } = issue;
	return t("settings.canvasOverLimit", { width, height, max });
}
