import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fingerprint } from "./server";

test("proxy cache identity follows content across copies and hard links", async () => {
	const dir = await fs.mkdtemp(path.join(tmpdir(), "proxy-fingerprint-"));
	const original = path.join(dir, "one.mp4");
	const link = path.join(dir, "two.mp4");
	const copy = path.join(dir, "three.mp4");
	try {
		await fs.writeFile(original, Buffer.alloc(256 * 1024, 3));
		await fs.link(original, link);
		await fs.copyFile(original, copy);
		expect(await fingerprint(original)).toEqual(await fingerprint(link));
		expect(await fingerprint(original)).toEqual(await fingerprint(copy));
		const file = await fs.open(copy, "r+");
		try { await file.write(Buffer.from([2]), 0, 1, 128 * 1024); }
		finally { await file.close(); }
		expect((await fingerprint(original)).key).not.toBe((await fingerprint(copy)).key);
	} finally {
		for (const file of [link, copy, original]) await fs.rm(file, { force: true });
		await fs.rmdir(dir);
	}
});
