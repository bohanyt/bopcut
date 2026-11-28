import { expect, test } from "bun:test";
import type { TimelineElement } from "@/timeline/types";
import { changedAttributes, planPasteAttributes } from "../paste-attributes";

const caption = (id: string, content: string, params: Record<string, unknown> = {}) => ({
	id, type: "text", name: id, startTime: 0, duration: 1000, trimStart: 0, trimEnd: 0,
	params: { content, "caption.reveal": false, "caption.revealFade": 0.12, "caption.revealPop": 1, ...params },
}) as unknown as TimelineElement;

test("only the settings the copied clip changed from their defaults are carried, never its text", () => {
	const source = caption("src", "Styled", { "caption.reveal": true, "caption.revealFade": 0.3 });
	expect(changedAttributes(source)).toEqual({ "caption.reveal": true, "caption.revealFade": 0.3 });
});

test("every selected clip of the same kind takes them, keeping its own text; other kinds are skipped", () => {
	const source = caption("src", "Styled", { "caption.reveal": true, "caption.revealFade": 0.3 });
	const audio = { id: "music", type: "audio", name: "music", startTime: 0, duration: 1000, trimStart: 0, trimEnd: 0, params: { volume: 0 } } as unknown as TimelineElement;
	const already = caption("c3", "Third", { "caption.reveal": true, "caption.revealFade": 0.3 });
	const plan = planPasteAttributes({
		source,
		targets: [
			{ track: { id: "captions" }, element: caption("c1", "First") },
			{ track: { id: "captions" }, element: caption("c2", "Second", { "caption.revealFade": 0.3 }) },
			{ track: { id: "captions" }, element: already },
			{ track: { id: "audio" }, element: audio },
		],
	});
	expect(plan.keys).toEqual(["caption.reveal", "caption.revealFade"]);
	expect(plan.updated.map(({ elementId }) => elementId)).toEqual(["c1", "c2", "c3"]);
	expect(plan.skipped).toEqual([{ trackId: "audio", elementId: "music" }]);
	// Only what differs is written; a clip that already matches needs no update.
	expect(plan.updates).toEqual([
		{ trackId: "captions", elementId: "c1", patch: { params: { "caption.reveal": true, "caption.revealFade": 0.3 } } },
		{ trackId: "captions", elementId: "c2", patch: { params: { "caption.reveal": true } } },
	]);
});
