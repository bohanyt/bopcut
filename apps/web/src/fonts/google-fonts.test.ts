import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const ATLAS = { fonts: { Roboto: { x: 0, y: 0, w: 100, ch: 0, s: [] } } };

describe("loadFontAtlas", () => {
	let calls: string[];
	let restore: () => void;

	beforeEach(() => {
		globalThis.Image = class { src = "" } as unknown as typeof Image;
		const real = globalThis.fetch;
		calls = [];
		globalThis.fetch = (async (input) => {
			calls.push(String(input));
			return nextFetch();
		}) as typeof fetch;
		restore = () => { globalThis.fetch = real; };
	});
	let nextFetch: () => Response | Promise<Response>;
	afterEach(async () => {
		restore();
		(await import("./google-fonts")).clearFontAtlasCache();
	});

	const atlasCount = () => calls.filter((u) => u.includes("font-atlas.json")).length;

	test("does not fetch until loadFontAtlas is called", async () => {
		nextFetch = () => Response.json(ATLAS);
		await import("./google-fonts");
		expect(atlasCount()).toBe(0);
	});

	test("one call fetches once; concurrent call does not fetch again", async () => {
		nextFetch = async () => { await new Promise((r) => setTimeout(r, 10)); return Response.json(ATLAS); };
		const { loadFontAtlas } = await import("./google-fonts");
		await Promise.all([loadFontAtlas(), loadFontAtlas()]);
		expect(atlasCount()).toBe(1);
	});

	test("failed fetch can be retried by a later call", async () => {
		let attempts = 0;
		nextFetch = async () => (++attempts === 1 ? new Response(null, { status: 500 }) : Response.json(ATLAS));
		const { loadFontAtlas } = await import("./google-fonts");
		expect(await loadFontAtlas()).toBeNull();
		expect(await loadFontAtlas()).not.toBeNull();
		expect(atlasCount()).toBe(2);
	});
});
