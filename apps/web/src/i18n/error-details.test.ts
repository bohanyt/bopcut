import { expect, test } from "bun:test";
import { normalizeSectionRequest } from "@/retrieval/time";
import { getDraftRejectionDescription, localizeErrorDetail } from "./error-details";
import { createTranslator } from "./translate";

const t = createTranslator("id");

test("localizes retrieval validation at the display boundary", () => {
	const request = normalizeSectionRequest({ url: "bad link" }, 60);
	if (request.ok) throw new Error("Invalid link was accepted");
	expect(request.error).toBe("url must be an http(s) link");
	expect(localizeErrorDetail(request.error, t)).toBe("Gunakan tautan HTTP atau HTTPS.");
});

test("preserves interpolation values and unknown diagnostics", () => {
	expect(localizeErrorDetail("section is 80 s; the limit is 60 s (whole videos are not fetched)", t))
		.toBe("Bagian ini berdurasi 80 dtk. Batasnya 60 dtk. Video utuh tidak diunduh.");
	expect(localizeErrorDetail("Storage failed (500): EBUSY", t)).toBe("Penyimpanan gagal (HTTP 500): EBUSY");
	expect(localizeErrorDetail("EIO", t)).toBe("EIO");
});

test("localizes snapshot and draft errors without dropping what the user can do next", () => {
	expect(localizeErrorDetail("Project is empty", t)).toBe(t("export.empty"));
	expect(localizeErrorDetail("Clipboard image copy is not supported in this browser", t))
		.toBe(t("preview.clipboardUnavailable"));
	expect(localizeErrorDetail("Some selected elements were not found in the scene", t))
		.toBe(t("timeline.compoundSelectionMissing"));
	expect(localizeErrorDetail("The 9000 × 1080 canvas exceeds this graphics device’s limit of 8192 pixels per side. Reduce the canvas size in Project Settings.", t))
		.toBe(t("settings.canvasOverLimit", { width: 9000, height: 1080, max: 8192 }));
});

test("keeps a stale atomic draft reason, recovery instructions, result file and cleanup warning together", () => {
	const error = "an op of this atomic draft failed; nothing was applied";
	expect(getDraftRejectionDescription({ error, stale: true, cleanupFailed: true }, t)).toBe([
		t("agentToast.atomicFailed"),
		t("agentToast.retryDraft"),
		t("agentToast.draftDetails"),
		t("agentToast.cleanupFailed"),
	].join(" "));
	expect(getDraftRejectionDescription({ error, stale: false, cleanupFailed: false }, t))
		.toBe([t("agentToast.atomicFailed"), t("agentToast.draftDetails")].join(" "));
});
