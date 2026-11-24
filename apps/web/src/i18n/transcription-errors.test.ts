import { expect, test } from "bun:test";
import { en } from "./en";
import { id } from "./id";
import {
	localizeTranscriptionPanelError,
	TRANSCRIPTION_PANEL_ERROR_KEYS,
} from "@/services/transcription/service";
import { createTranslator } from "./translate";

const tId = createTranslator("id");

test("known transcription panel errors map to keys in both dictionaries", () => {
	for (const [message, key] of TRANSCRIPTION_PANEL_ERROR_KEYS) {
		expect(key in en).toBe(true);
		expect(key in id).toBe(true);
		expect(localizeTranscriptionPanelError(message, tId)).toBe(tId(key));
	}
	expect(localizeTranscriptionPanelError("Unknown model: whisper-large", tId)).toBe(
		tId("captions.unknownModel", { model: "whisper-large" }),
	);
	expect(localizeTranscriptionPanelError("Unknown model: whisper-large", tId)).toContain(
		"whisper-large",
	);
	expect(localizeTranscriptionPanelError("EIO", tId)).toBe("EIO");
});
