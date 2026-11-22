import { GraphicsDeviceError } from "@/services/renderer/device-lifecycle";
import type { ExportResult } from "./index";

export function getExportFailure(error: unknown): ExportResult {
	return {
		success: false,
		error: error instanceof Error ? error.message : "Unknown export error",
		...(error instanceof GraphicsDeviceError && { issue: { kind: error.kind } }),
	};
}
