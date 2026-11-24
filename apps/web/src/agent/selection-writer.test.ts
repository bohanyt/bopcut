import { expect, test } from "bun:test";
import { createSelectionWriter } from "./selection-writer";

test("selection waits for the scrub to settle before sending", async () => {
	let isScrubbing = false;
	let body = "before scrub";
	const sent: string[] = [];
	const writer = createSelectionWriter({
		isScrubbing: () => isScrubbing,
		readBody: () => body,
		send: async (payload) => { sent.push(payload); },
	});
	writer.schedule();
	isScrubbing = true;
	body = "during scrub";
	writer.schedule();
	await Bun.sleep(275);
	expect(sent).toEqual([]);
	isScrubbing = false;
	body = "after release";
	writer.schedule();
	await Bun.sleep(275);
	expect(sent).toEqual(["after release"]);
});

test("an in-flight selection write settles before sending the latest large selection", async () => {
	const firstStarted = Promise.withResolvers<void>();
	const finishFirst = Promise.withResolvers<void>();
	const latestSent = Promise.withResolvers<void>();
	const largeSelection = "x".repeat(1_220_000);
	const sent: string[] = [];
	let body = "before the new selection";
	const writer = createSelectionWriter({
		isScrubbing: () => false,
		readBody: () => body,
		send: async (payload) => {
			sent.push(payload);
			if (sent.length === 1) {
				firstStarted.resolve();
				await finishFirst.promise;
			} else {
				latestSent.resolve();
			}
		},
	});
	writer.schedule();
	await firstStarted.promise;
	body = "intermediate selection";
	writer.schedule();
	await Bun.sleep(275);
	body = largeSelection;
	writer.schedule();
	await Bun.sleep(275);
	expect(sent).toEqual(["before the new selection"]);
	finishFirst.resolve();
	await latestSent.promise;
	expect(sent).toHaveLength(2);
	expect(sent[1] === largeSelection).toBe(true);
});
