import { expect, test } from "bun:test";
import { createSelectionWriter } from "./selection-writer";

test("page exit flushes the latest settled selection exactly once with keepalive", async () => {
	let isScrubbing = false;
	let body = "before scrub";
	const sent: Array<[string, boolean]> = [];
	const writer = createSelectionWriter({
		isScrubbing: () => isScrubbing,
		readBody: () => body,
		send: async (payload, keepalive) => { sent.push([payload, keepalive]); },
	});
	writer.schedule();
	isScrubbing = true;
	body = "during scrub";
	writer.schedule();
	writer.flushOnHide();
	expect(sent).toEqual([]);
	isScrubbing = false;
	body = "after release";
	writer.schedule();
	writer.flushOnHide();
	writer.flushOnHide();
	await Bun.sleep(275);
	expect(sent).toEqual([["after release", true]]);
});
