import { expect, test } from "bun:test";
import type { NextConfig } from "next";
import path from "node:path";

async function loadNextConfig(): Promise<NextConfig> {
	const stamp = `${Date.now()}-${Math.random()}`;
	const mod = await import(`../next.config.ts?${stamp}`);
	return await (mod.default as Promise<NextConfig>);
}

test("standalone output only when BOPENCUT_STANDALONE=1", async () => {
	const prev = process.env.BOPENCUT_STANDALONE;
	try {
		delete process.env.BOPENCUT_STANDALONE;
		const without = await loadNextConfig();
		expect(without.output).toBeUndefined();

		process.env.BOPENCUT_STANDALONE = "1";
		const withStandalone = await loadNextConfig();
		expect(withStandalone.output).toBe("standalone");
		const repositoryRoot = path.resolve(import.meta.dir, "../../..");
		expect(withStandalone.outputFileTracingRoot).toBe(repositoryRoot);
		expect(withStandalone.turbopack?.root).toBe(repositoryRoot);
	} finally {
		if (prev === undefined) delete process.env.BOPENCUT_STANDALONE;
		else process.env.BOPENCUT_STANDALONE = prev;
	}
});
