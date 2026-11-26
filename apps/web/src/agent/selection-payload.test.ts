import { describe, expect, test } from "bun:test";
import { boundSelectionPayload, MAX_SELECTED, MAX_SELECTION_BYTES, NO_SELECTION, parseSelectionPayload } from "./selection-payload";

const now = new Date("2026-01-02T03:04:05.000Z");
const valid = { projectId: "p", sceneId: "main", activeSceneId: "s1", playhead: 12.5, selected: [{ id: "c1", track: { id: "t", name: "Clips", type: "video" } }] };

describe("selection.json payload", () => {
	test("the byte limit keeps a whole prefix and the server preserves the truncation flag", () => {
		const item = { id: "wide", text: "😀".repeat(600_000) };
		const selected = [valid.selected[0], item, { ...item, id: "discarded" }];
		const payload = boundSelectionPayload({ ...valid, selected });
		expect(payload.selected.map((entry) => entry.id)).toEqual(["c1", "wide"]);
		expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(MAX_SELECTION_BYTES);
		expect(parseSelectionPayload(payload, now)).toMatchObject({ truncated: true });
	});
	test("a valid selection keeps only the known fields and gets the server's timestamp", () => {
		const file = parseSelectionPayload({ ...valid, updatedAt: "1999-01-01", extra: "dropped" }, now);
		expect(file).toEqual({ ...valid, updatedAt: "2026-01-02T03:04:05.000Z" });
	});

	test("no open project is an empty selection", () => {
		expect(parseSelectionPayload(NO_SELECTION, now)).toEqual({ ...NO_SELECTION, updatedAt: "2026-01-02T03:04:05.000Z" });
		expect(parseSelectionPayload({ ...NO_SELECTION, selected: [{ id: "x" }] })).toBeNull();
		expect(parseSelectionPayload({ ...NO_SELECTION, playhead: 3 })).toBeNull();
	});

	test("malformed payloads are refused", () => {
		for (const bad of [
			null,
			[],
			"x",
			{ ...valid, projectId: 5 },
			{ ...valid, projectId: "" },
			{ ...valid, sceneId: {} },
			{ ...valid, playhead: -1 },
			{ ...valid, playhead: Number.NaN },
			{ ...valid, playhead: "3" },
			{ ...valid, selected: "c1" },
			{ ...valid, selected: [null] },
			{ ...valid, selected: [{ name: "no id" }] },
			{ ...valid, selected: Array.from({ length: MAX_SELECTED + 1 }, (_, i) => ({ id: `e${i}` })) },
		]) {
			expect(parseSelectionPayload(bad)).toBeNull();
		}
	});
});
