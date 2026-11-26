import { expect, test } from "bun:test";
import { en } from "./en";
import { id } from "./id";

/**
 * bopcut is built on OpenCut and says so on the pages about the project. Those pages get their own
 * pass; everywhere else (the editor, its dialogs, the agent pages) the product is called bopcut.
 */
const PAGES_ABOUT_THE_PROJECT = [
	"header.", "footer.", "site.", "landing.", "blog.", "changelog.", "sponsors.", "contributors.",
	"brand.", "roadmap.", "privacy.", "terms.",
];

test("the editor does not call the product OpenCut", () => {
	for (const [locale, messages] of [["en", en], ["id", id]] as const) {
		const named = Object.entries(messages)
			.filter(([key, message]) => /OpenCut/.test(message) && !PAGES_ABOUT_THE_PROJECT.some((prefix) => key.startsWith(prefix)))
			.map(([key]) => `${locale}: ${key}`);
		expect(named).toEqual([]);
	}
});

test("upstream's beta welcome dialog is gone with its messages", async () => {
	expect(Object.keys(en).filter((key) => key.startsWith("onboarding."))).toEqual([]);
	expect(await Bun.file(new URL("../components/editor/onboarding.tsx", import.meta.url)).exists()).toBe(false);
	const editorPage = await Bun.file(new URL("../app/editor/[project_id]/page.tsx", import.meta.url)).text();
	expect(editorPage).not.toContain("Onboarding");
});
