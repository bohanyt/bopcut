import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withSectionInputs } from "./section-source";
import { defaultRunner, fetchSection, type Runner } from "./server";

const url = "http://127.0.0.1/fixture";
const env = { BOPENCUT_ALLOW_PRIVATE_URLS: "1" };

test("refuses a source that ignores ranges before starting FFmpeg", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "section-refusal-"));
	let tools = 0;
	const runner: Runner = async () => {
		tools++;
		return { stdout: JSON.stringify({ url, protocol: "http", duration: 1000 }), stderr: "" };
	};
	try {
		await expect(fetchSection({ url, start: 800, end: 801 }, {
			filesRoot: root, env, runner, fetchImpl: Object.assign(async () => new Response(null, { status: 200 }), { preconnect: fetch.preconnect }),
		})).rejects.toThrow(/seekable/);
		expect(tools).toBe(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test.each([60, 10_800])("a one-second seek transfers only a small part of a %s-second low-bitrate source", async (duration) => {
	const total = duration * 16_000 + 44;
	const startTime = Math.floor(duration * 0.8);
	const root = await mkdtemp(path.join(tmpdir(), "section-range-"));
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(total - 8, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(8000, 24);
	header.writeUInt32LE(16000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(total - 44, 40);
	const ranges: [number, number][] = [];
	const fetchImpl: typeof fetch = Object.assign(async (_url: string | URL | Request, init?: RequestInit) => {
		const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("range") ?? "") ?? [];
		if (!a || !b) throw new Error("expected a bounded range");
		const start = Number(a), end = Number(b);
		ranges.push([start, end]);
		const body = Buffer.alloc(end - start + 1);
		if (start < header.length) header.copy(body, 0, start, end + 1);
		return new Response(body, { status: 206, headers: { "Content-Range": "bytes " + start + "-" + end + "/" + total } });
	}, { preconnect: fetch.preconnect });
	const runner: Runner = (command, args, signal, cwd) => command === "yt-dlp"
		? Promise.resolve({ stdout: JSON.stringify({ url, protocol: "http", duration }), stderr: "" })
		: defaultRunner(command, args, signal, cwd);
	try {
		const result = await fetchSection({ url, start: startTime, end: startTime + 1, audioOnly: true }, { filesRoot: root, env, runner, fetchImpl });
		expect(result.type).toBe("audio");
		expect(ranges[0]).toEqual([0, 0]);
		expect(ranges.some(([start]) => start === startTime * 16_000 + 44)).toBe(true);
		expect(ranges.reduce((bytes, [start, end]) => bytes + end - start + 1, 0)).toBeLessThan(9 * 16_000 + 64); // Allow one extra read and the range probe across demuxer versions.
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("a range redirect applies the browser cookie only within its path scope", async () => {
	const seen: (string | null)[] = [];
	const fetchImpl = Object.assign(async (_u: string | URL | Request, init?: RequestInit) => {
		seen.push(new Headers(init?.headers).get("cookie"));
		return seen.length === 1
			? new Response(null, { status: 302, headers: { location: "/other" } })
			: new Response(null, { status: 206, headers: { "Content-Range": "bytes 0-0/1000000" } });
	}, { preconnect: fetch.preconnect });
	await withSectionInputs([{
		url: "https://example.com/private/video", protocol: "https",
		cookies: "session=fixture; Domain=example.com; Path=/private; Secure; common=yes; Domain=example.com; Path=/",
	}], 1000, 1, { fetchImpl, env, signal: new AbortController().signal }, async () => {});
	expect(seen).toEqual(["session=fixture; common=yes", "common=yes"]);
});
