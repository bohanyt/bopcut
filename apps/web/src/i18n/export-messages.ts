import { localizeErrorDetail } from "@/i18n/error-details";
import type { ExportResult } from "@/export";
import { getCanvasIssueMessage } from "./canvas-messages";
import type { createTranslator } from "./translate";

export function getExportErrorMessage(result: ExportResult, t: ReturnType<typeof createTranslator>) {
	if (result.missingMedia?.length) return t("export.missingMedia");
	const { issue } = result;
	if (!issue) return result.error ? localizeErrorDetail(result.error, t) : t("export.unknownError");
	switch (issue.kind) {
		case "canvasInvalid":
		case "canvasOverLimit":
			return getCanvasIssueMessage(issue, t);
		case "evenDimensions":
			return t("export.evenDimensions", { width: issue.width, height: issue.height });
		default:
			return t(`export.${issue.kind}`);
	}
}
