import { afterEach, beforeEach, expect, test } from "bun:test";
import { EditorCore } from "@/core";
import { fixture, getHost, text } from "@/timeline/__tests__/compound-fixtures";
import { clearFontAtlasCache, loadFullFont, subscribeFontLoads } from "./google-fonts";

class FakeLink extends EventTarget {
	rel = "";
	href = "";
	removed = false;
	remove() {
		this.removed = true;
	}
}
let links: FakeLink[] = [];
const original = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
	links = [];
	clearFontAtlasCache();
	const document = {
		createElement: () => {
			const link = new FakeLink();
			links.push(link);
			return link;
		},
		head: { appendChild: () => {} },
		fonts: { load: async () => [] },
	};
	Object.defineProperty(globalThis, "document", { value: document, configurable: true, writable: true });
});

afterEach(() => {
	EditorCore.reset();
	clearFontAtlasCache();
	if (original) Object.defineProperty(globalThis, "document", original);
	else Reflect.deleteProperty(globalThis, "document");
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("concurrent loads share one request, and a failed one is retried", async () => {
	let loaded = 0;
	const unsubscribe = subscribeFontLoads(() => loaded++);
	const first = loadFullFont({ family: "Bangers" });
	const second = loadFullFont({ family: "Bangers" });
	expect(links).toHaveLength(1);
	links[0].dispatchEvent(new Event("error"));
	await Promise.all([first, second]);
	expect(links[0].removed).toBe(true);
	expect(loaded).toBe(0);

	const retry = loadFullFont({ family: "Bangers" });
	expect(links).toHaveLength(2);
	links[1].dispatchEvent(new Event("load"));
	await retry;
	expect(loaded).toBe(1);
	await loadFullFont({ family: "Bangers" });
	expect(links).toHaveLength(2);
	unsubscribe();
});

test("text added while the project is open loads its font", async () => {
	const editor = EditorCore.getInstance();
	const scenes = fixture();
	const host = getHost(scenes);
	const title = text("title", 0, 2);
	host.tracks.overlay = [{ id: "titles", name: "Titles", type: "text", hidden: false, elements: [{
		...title, params: { ...title.params, fontFamily: "Bangers" },
	}] }];
	const date = new Date(0);
	editor.project.setActiveProject({ project: {
		metadata: { id: "p", name: "Project", duration: 0, createdAt: date, updatedAt: date },
		currentSceneId: host.id, scenes, version: 1,
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000000" } },
	} as never });
	editor.scenes.setScenes({ scenes, activeSceneId: host.id });
	await settle();
	expect(links.map(({ href }) => href)).toEqual([expect.stringContaining("family=Bangers")]);
	links[0].dispatchEvent(new Event("load"));
	await settle();

	// A later edit with the same font sends nothing new.
	editor.scenes.setScenes({ scenes: [...scenes], activeSceneId: host.id });
	await settle();
	expect(links).toHaveLength(1);
});
