import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the container copies the local WASM package before installing dependencies", () => {
	const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
	const manifest = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
	const archive = manifest.dependencies["opencut-wasm"].replace("file:../../", "");
	const copy = dockerfile.indexOf(`COPY ${archive} ${archive}`);
	expect(copy).toBeGreaterThanOrEqual(0);
	expect(copy).toBeLessThan(dockerfile.indexOf("RUN bun install"));
});

test("the container includes Bun's patches at install time", () => {
	const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
	expect(dockerfile.split("RUN bun install")[0]).toContain("COPY patches/ patches/");
});
