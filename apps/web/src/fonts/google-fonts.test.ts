import { afterEach, beforeEach, expect, test } from "bun:test";
import { clearFontAtlasCache, loadFontAtlas } from "./google-fonts";

const originals = {
	fetch: Object.getOwnPropertyDescriptor(globalThis, "fetch"),
	Image: Object.getOwnPropertyDescriptor(globalThis, "Image"),
};
let requests = 0;
let respond: () => Response | Promise<Response>;

beforeEach(() => {
	requests = 0;
	clearFontAtlasCache();
	const replacements = { fetch: async () => { requests++; return respond(); }, Image: class { src = ""; } };
	for (const [key, value] of Object.entries(replacements)) {
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
});

afterEach(() => {
	clearFontAtlasCache();
	for (const [key, descriptor] of Object.entries(originals)) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

const atlas = () => Response.json({ fonts: { Roboto: { x: 0, y: 0, w: 100, ch: 0, s: [] } } });

test("concurrent and later requests share one font atlas download", async () => {
	respond = atlas;
	const [first, second] = await Promise.all([loadFontAtlas(), loadFontAtlas()]);
	expect(first).not.toBeNull();
	expect(second).toBe(first);
	expect(await loadFontAtlas()).toBe(first);
	expect(requests).toBe(1);
});

test.each(["status", "network"] as const)("a font atlas request that failed (%s) can be retried", async (failure) => {
	respond = () => failure === "status" ? new Response(null, { status: 500 }) : Promise.reject(new Error("offline"));
	expect(await loadFontAtlas()).toBeNull();
	respond = atlas;
	expect(await loadFontAtlas()).not.toBeNull();
	expect(requests).toBe(2);
});
