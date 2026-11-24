import { expect, test } from "bun:test";
import { proxyTime } from "./mapping";

test("proxy mapping keeps the original VFR frame across timestamp offsets and holds", () => {
	const info = { key: "fixture", width: 1919, height: 1079, source: [5, 5.04, 5.16], proxy: [0, 0.04, 0.16] };
	expect(proxyTime(info, 5.01)).toBe(0.02);
	expect(proxyTime(info, 5.04)).toBe(0.1);
	expect(proxyTime(info, 5.159)).toBe(0.1);
	expect(proxyTime(info, 20)).toBeGreaterThanOrEqual(0.16);
	expect(proxyTime(info, 0)).toBe(0.02);
	expect(proxyTime({ ...info, proxy: [] }, 5)).toBeUndefined();
});
