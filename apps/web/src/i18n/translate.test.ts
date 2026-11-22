import { expect, test } from "bun:test";
import { en } from "./en";
import { id } from "./id";
import { createTranslator, placeholderPattern, type MessageKey } from "./translate";
import { getExportFailure } from "@/export/failure";
import { GraphicsDeviceError, type GraphicsIssueKind } from "@/services/renderer/device-lifecycle";
import { getExportErrorMessage } from "./export-messages";

function placeholders(message: string): string[] {
	return Array.from(message.matchAll(placeholderPattern), (match) => match[1]).sort();
}

test("every Indonesian message has the same placeholders as its English source", () => {
	for (const key of Object.keys(en) as MessageKey[]) {
		expect(placeholders(id[key]), key).toEqual(placeholders(en[key]));
	}
});

test("translates and interpolates numbers and text without interpreting inserted text", () => {
	const t = createTranslator("id");
	expect(t("projects.deleteMultiple", { count: 3 })).toBe("Hapus 3 proyek?");
	expect(t("projects.noSearchResults", { query: "{query}$&" }))
		.toBe('Tidak ada hasil untuk pencarian "{query}$&".');
});

test("formats an export issue for users while preserving the agent diagnostic", () => {
	const result = {
		success: false,
		error: "MP4 needs even canvas dimensions.",
		issue: { kind: "evenDimensions", width: 1921, height: 1080 },
	} as const;
	expect(getExportErrorMessage(result, createTranslator("id")))
		.toContain("MP4 memerlukan dimensi kanvas genap (1921 × 1080)");
	expect(result.error).toBe("MP4 needs even canvas dimensions.");
});

test("preserves the technical details of unexpected export errors", () => {
	expect(getExportErrorMessage({ success: false, error: "encoder refused the configuration" }, createTranslator("id")))
		.toBe("encoder refused the configuration");
});

const graphicsErrors: [GraphicsIssueKind, string][] = [
	["graphicsLost", "Koneksi ke perangkat grafis terputus."],
	["graphicsModel", "Grafis 3D tidak tersedia."],
	["graphicsNotReady", "Grafis sedang dimulai atau dipulihkan."],
	["graphicsSurface", "Permukaan grafis sementara tidak tersedia."],
	["graphicsUnavailable", "Preview dan ekspor tidak tersedia."],
];

test.each(graphicsErrors)("translates %s and preserves the diagnostic", (kind, message) => {
	const diagnostic = "Graphics diagnostic";
	const result = getExportFailure(new GraphicsDeviceError(kind, diagnostic));
	expect(getExportErrorMessage(result, createTranslator("id"))).toStartWith(message);
	expect(result.error).toBe(diagnostic);
});
