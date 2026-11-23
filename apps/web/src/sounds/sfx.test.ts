import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Runner } from "@/retrieval/server";
import { clearLibraryIndex, handleSfx, libraryPreviewFile, libraryRoots, parseMyinstants, resolveLibraryFile, resolveLibraryRef, scoreEntry, words } from "./sfx-server";

const PAGE = `
<div id="instants_container"><div class="instants result-page">
<div class="instant">
<button class="small-button" onclick="play('/media/sounds/vine-boom.mp3', 'loader-81126', 'vine-boom-sound-70972')" title="Play"></button>
<a href="/en/instant/vine-boom-sound-70972/" class="instant-link link-secondary">VINE BOOM SOUND</a>
</div>
<div class="instant">
<button class="small-button" onclick="play('/media/sounds/bruh-sound-effect_WstdzdM.mp3', 'loader-1', 'bruh-1')"></button>
<a href="/en/instant/bruh-1/" class="instant-link link-secondary">Bruh &amp; friends&#39;</a>
</div>
<div class="instant">
<button onclick="play('/media/sounds/vine-boom.mp3', 'loader-2', 'vine-boom-dup')"></button>
<a class="instant-link">duplicate</a>
</div>
<div class="instant">
<button onclick="play('https://evil.example/x.mp3', 'loader-3', 'bad')"></button>
<a class="instant-link">external</a>
</div>
<div class="instant">
<button onclick="play('/media/sounds/../../secret.mp3', 'loader-4', 'bad2')"></button>
<a class="instant-link">traversal</a>
</div>
</div></div>`;

describe("myinstants parsing", () => {
	test("reads name, sound and page; skips duplicates, foreign hosts and odd paths", () => {
		const results = parseMyinstants(PAGE);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			source: "myinstants",
			ref: "/media/sounds/vine-boom.mp3",
			name: "VINE BOOM SOUND",
			tags: [],
			previewUrl: "https://www.myinstants.com/media/sounds/vine-boom.mp3",
			pageUrl: "https://www.myinstants.com/en/instant/vine-boom-sound-70972/",
		});
		expect(results[1].name).toBe("Bruh & friends'");
	});
});

describe("matching", () => {
	test("words without accents or punctuation", () => {
		expect(words("Vine-Boom_SFX (Kéras)!")).toEqual(["vine", "boom", "sfx", "keras"]);
	});
	test("every word must match; names rank above tags", () => {
		const entry = { nameWords: ["vine", "boom", "loud"], tags: ["memes"] };
		expect(scoreEntry(["vine", "boom"], entry)).toBe(6);
		expect(scoreEntry(["vin"], entry)).toBe(2);
		expect(scoreEntry(["meme"], entry)).toBe(1);
		expect(scoreEntry(["vine", "cat"], entry)).toBe(0);
	});
});

describe("library and downloads", () => {
	let root: string;
	let extra: string;
	let env: Record<string, string>;
	let calls: string[][];
	const runner: Runner = async (_command, args) => {
		calls.push(args);
		if (args.includes("volumedetect")) return { stdout: "", stderr: "[Parsed_volumedetect_0] max_volume: -6.5 dB\n" };
		await fs.writeFile(args.at(-1) as string, "normalized");
		return { stdout: "", stderr: "" };
	};
	const page = (html: string, status = 200) => new Response(html, { status });
	let fetched: string[];
	const fetchImpl = (async (url: string | URL | Request) => {
		const u = String(url);
		fetched.push(u);
		if (u.includes("/en/search/")) return page(PAGE);
		if (u.endsWith(".mp3")) return new Response(new Uint8Array([1, 2, 3]));
		return page("", 404);
	}) as typeof fetch;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-root-"));
		extra = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-extra-"));
		await fs.mkdir(path.join(extra, "memes", "boom"), { recursive: true });
		await fs.writeFile(path.join(extra, "memes", "boom", "vine-boom_48k.wav"), "wav");
		await fs.writeFile(path.join(extra, "memes", "huh-cat-meme.mp3"), "mp3");
		await fs.writeFile(path.join(extra, "notes.txt"), "not audio");
		env = { BOPENCUT_SFX_DIRS: extra, BOPENCUT_ALLOW_PRIVATE_URLS: "1" }; // fake fetch: no DNS check
		calls = [];
		fetched = [];
		clearLibraryIndex();
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(extra, { recursive: true, force: true });
	});

	test("roots: the workspace sfx folder first, then BOPENCUT_SFX_DIRS", () => {
		expect(libraryRoots(root, env)).toEqual([path.join(root, "sfx"), path.resolve(extra)]);
		expect(libraryRoots(root, { BOPENCUT_SFX_DIRS: `${extra}${path.delimiter}${extra}` })).toHaveLength(2);
	});

	test("library search by name and folder, with previews", async () => {
		const r = await handleSfx({ kind: "search", query: "vine boom", sources: ["library"] }, { filesRoot: root, env });
		expect(r.status).toBe(200);
		const { results } = r.body as { results: { name: string; ref: string; tags: string[]; previewUrl: string }[] };
		expect(results.map((x) => x.name)).toEqual(["vine boom 48k"]);
		expect(results[0].tags).toEqual(["memes", "boom"]);
		expect(results[0].previewUrl).toStartWith("/api/agent/sfx-file?ref=");
		expect(await libraryPreviewFile(results[0].ref, { filesRoot: root, env })).toBe(path.join(path.resolve(extra), "memes", "boom", "vine-boom_48k.wav"));
		const byTag = await handleSfx({ kind: "search", query: "memes", sources: ["library"] }, { filesRoot: root, env });
		expect((byTag.body as { results: unknown[] }).results).toHaveLength(2);
	});

	test("library references cannot leave their folder", () => {
		const roots = libraryRoots(root, env);
		expect(() => resolveLibraryRef("lib:1:../../etc/passwd.mp3", roots)).toThrow();
		expect(() => resolveLibraryRef("lib:1:notes.txt", roots)).toThrow();
		expect(() => resolveLibraryRef("lib:9:x.mp3", roots)).toThrow();
		expect(() => resolveLibraryRef("../x.mp3", roots)).toThrow();
		expect(resolveLibraryRef("lib:1:memes/huh-cat-meme.mp3", roots).file).toBe(path.join(path.resolve(extra), "memes", "huh-cat-meme.mp3"));
	});

	test("a library sound outside AGENT_FILES_ROOT is copied in once", async () => {
		const ref = "lib:1:memes/huh-cat-meme.mp3";
		const first = (await handleSfx({ kind: "get", source: "library", ref }, { filesRoot: root, env })).body as { path: string; cached: boolean; name: string };
		expect(first.path).toMatch(/^sfx\/library\/[0-9a-f]{8}-huh-cat-meme\.mp3$/);
		expect(first.cached).toBe(false);
		expect(first.name).toBe("huh cat meme");
		expect(await fs.readFile(path.join(root, first.path), "utf8")).toBe("mp3");
		const second = (await handleSfx({ kind: "get", source: "library", ref }, { filesRoot: root, env })).body as { path: string; cached: boolean };
		expect(second).toMatchObject({ path: first.path, cached: true });
	});

	test("myinstants: search, then download once with peak normalization", async () => {
		const deps = { filesRoot: root, env, fetchImpl, runner };
		const search = await handleSfx({ kind: "search", query: "vine boom", sources: ["myinstants"] }, deps);
		expect((search.body as { results: unknown[] }).results).toHaveLength(2);
		expect(fetched[0]).toBe("https://www.myinstants.com/en/search/?name=vine%20boom");

		const got = (await handleSfx({ kind: "get", source: "myinstants", ref: "/media/sounds/vine-boom.mp3" }, deps)).body as { path: string; cached: boolean; name: string };
		expect(got).toMatchObject({ cached: false, name: "vine boom" });
		expect(got.path).toMatch(/^sfx\/myinstants\/vine-boom-[0-9a-f]{6}\.asset\/vine-boom-[0-9a-f]{6}\.m4a$/);
		expect(calls[1].join(" ")).toContain("volume=5.50dB");
		const stem = path.basename(got.path, ".m4a");
		expect((await fs.readdir(path.dirname(path.join(root, got.path)))).sort()).toEqual([`${stem}.json`, `${stem}.m4a`]);

		const again = (await handleSfx({ kind: "get", source: "myinstants", ref: "/media/sounds/vine-boom.mp3" }, deps)).body as { cached: boolean };
		expect(again.cached).toBe(true);
		expect(fetched.filter((u) => u.endsWith(".mp3"))).toHaveLength(1);

		// A saved sound is part of the library from then on.
		const local = await handleSfx({ kind: "search", query: "vine boom", sources: ["library"] }, deps);
		expect((local.body as { results: { name: string }[] }).results.map((x) => x.name).sort()).toEqual(["vine boom", "vine boom 48k"]);
	});

	test("myinstants: titles beat file names, matching titles rank first, and the title is searchable later", async () => {
		const deps = { filesRoot: root, env, fetchImpl, runner };
		const search = (await handleSfx({ kind: "search", query: "bruh", sources: ["myinstants"] }, deps)).body as { results: { name: string }[] };
		expect(search.results.map((r) => r.name)).toEqual(["Bruh & friends'", "VINE BOOM SOUND"]);
		const found = (await handleSfx({ kind: "find", query: "bruh" }, deps)).body as { path: string; name: string; pageUrl: string };
		expect(found).toMatchObject({ name: "Bruh & friends'", pageUrl: "https://www.myinstants.com/en/instant/bruh-1/" });
		expect(found.path).toMatch(/^sfx\/myinstants\/bruh-sound-effect_WstdzdM-[0-9a-f]{6}\.asset\/bruh-sound-effect_WstdzdM-[0-9a-f]{6}\.m4a$/);
		const later = (await handleSfx({ kind: "search", query: "friends", sources: ["library"] }, deps)).body as { results: { name: string }[] };
		expect(later.results.map((r) => r.name)).toEqual(["Bruh & friends'"]);
		const foreign = (await handleSfx({ kind: "get", source: "myinstants", ref: "/media/sounds/vine-boom.mp3", name: "Boom", pageUrl: "https://evil.example/" }, deps)).body as { pageUrl: string; name: string };
		expect(foreign.name).toBe("Boom");
		expect(foreign.pageUrl).toStartWith("https://www.myinstants.com/");
	});

	test("normalization off keeps the file as downloaded", async () => {
		const got = (await handleSfx({ kind: "get", source: "myinstants", ref: "/media/sounds/vine-boom.mp3" }, { filesRoot: root, env: { ...env, BOPENCUT_SFX_NORMALIZE: "off" }, fetchImpl, runner })).body as { path: string };
		expect(got.path).toMatch(/^sfx\/myinstants\/vine-boom-[0-9a-f]{6}\.asset\/vine-boom-[0-9a-f]{6}\.mp3$/);
		expect(calls).toHaveLength(0);
	});

	test("find returns the best match ready to use; unknown sounds are 404", async () => {
		const found = await handleSfx({ kind: "find", query: "huh cat" }, { filesRoot: root, env, fetchImpl, runner });
		expect(found.status).toBe(200);
		expect((found.body as { source: string }).source).toBe("library");
		const missing = await handleSfx({ kind: "find", query: "nothing matches this", sources: ["library"] }, { filesRoot: root, env });
		expect(missing.status).toBe(404);
	});

	test("a failing source does not hide the others", async () => {
		const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
		const r = await handleSfx({ kind: "search", query: "vine" }, { filesRoot: root, env, fetchImpl: down });
		const body = r.body as { results: { source: string }[]; errors: { source: string }[] };
		expect(body.results.every((x) => x.source === "library")).toBe(true);
		expect(body.errors.map((e) => e.source)).toEqual(["myinstants"]);
	});

	test("bad requests", async () => {
		const deps = { filesRoot: root, env, fetchImpl, runner };
		expect((await handleSfx({ kind: "search", query: " " }, deps)).status).toBe(400);
		expect((await handleSfx({ kind: "search", query: "x", sources: ["web"] }, deps)).status).toBe(400);
		expect((await handleSfx({ kind: "get", source: "myinstants", ref: "https://evil.example/a.mp3" }, deps)).status).toBe(502);
		expect((await handleSfx({ kind: "get", source: "library", ref: "lib:1:../x.mp3" }, deps)).status).toBe(502);
		expect((await handleSfx({ kind: "other" }, deps)).status).toBe(400);
		expect(fetched).toHaveLength(0);
	});
});

describe("review hardening", () => {
	test("a symlink inside a library folder cannot reach outside it", async () => {
		const { mkdtemp, rm, symlink, writeFile } = fs;
		const lib = await mkdtemp(path.join(os.tmpdir(), "sfx-lib-"));
		const outside = await mkdtemp(path.join(os.tmpdir(), "sfx-out-"));
		await writeFile(path.join(outside, "secret.mp3"), "x");
		let linked = true;
		try {
			await symlink(path.join(outside, "secret.mp3"), path.join(lib, "trap.mp3"));
		} catch {
			linked = false; // no permission to create symlinks here
		}
		if (linked) {
			const roots = [path.resolve(lib)];
			await expect(resolveLibraryFile("lib:0:trap.mp3", roots)).rejects.toThrow();
		}
		await rm(lib, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	});

	test("find stops at the first source with a match, so a local hit never queries myinstants", async () => {
		const lib = await fs.mkdtemp(path.join(os.tmpdir(), "sfx-find-"));
		await fs.writeFile(path.join(lib, "private clip name.mp3"), "x");
		const asked: string[] = [];
		const fetchImpl = (async (u: string | URL | Request) => {
			asked.push(String(u));
			return new Response("", { status: 404 });
		}) as typeof fetch;
		const r = await handleSfx({ kind: "find", query: "private clip" }, { filesRoot: lib, env: { BOPENCUT_SFX_DIRS: lib, BOPENCUT_ALLOW_PRIVATE_URLS: "1" }, fetchImpl });
		expect(r.status).toBe(200);
		expect(asked).toEqual([]);
		await fs.rm(lib, { recursive: true, force: true });
	});
});
