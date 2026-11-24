import { expect, test } from "bun:test";
import type { FrameRate } from "opencut-wasm";
import { frameRateToFloat } from "@/fps/utils";
import { formatRulerLabel } from "./ruler-utils";

function legacyLabel(timeInSeconds: number, fps: number): string {
	const r = timeInSeconds % 1;
	if (r < 0.0001 || r > 1 - 0.0001) {
		const t = Math.round(timeInSeconds);
		const m = Math.floor((t % 3600) / 60);
		const s = t % 60;
		return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	}
	return `${Math.round(r * fps)}f`;
}

test("NTSC ruler labels", () => {
	const rates: FrameRate[] = [
		{ numerator: 24_000, denominator: 1_001 },
		{ numerator: 30_000, denominator: 1_001 },
		{ numerator: 60_000, denominator: 1_001 },
	];
	for (const fps of rates) {
		const rate = frameRateToFloat(fps);
		for (let frame = 0; frame <= Math.floor(120 * rate); frame++) {
			expect(formatRulerLabel({ timeInSeconds: frame / rate, fps })).not.toBe("0f");
		}
		const s1 = Math.ceil(rate - 1e-6);
		expect(formatRulerLabel({ timeInSeconds: s1 / rate, fps })).toBe("00:01");
		expect(formatRulerLabel({ timeInSeconds: (s1 + 1) / rate, fps })).toBe("1f");
		const lo = Math.ceil(5 * rate - 1e-6);
		const hi = Math.ceil(6 * rate - 1e-6) - 1;
		let prev: number | null = null;
		for (let frame = lo; frame <= hi; frame++) {
			const label = formatRulerLabel({ timeInSeconds: frame / rate, fps });
			if (label.endsWith("f")) {
				const idx = Number(label.slice(0, -1));
				if (prev !== null) expect(idx).toBe(prev + 1);
				prev = idx;
			} else {
				prev = 0;
			}
		}
	}
});

test("integer fps ruler labels unchanged", () => {
	const rates: FrameRate[] = [
		{ numerator: 24, denominator: 1 },
		{ numerator: 25, denominator: 1 },
		{ numerator: 30, denominator: 1 },
		{ numerator: 60, denominator: 1 },
	];
	for (const fps of rates) {
		const rate = frameRateToFloat(fps);
		for (let frame = 0; frame <= Math.floor(10 * rate); frame++) {
			const time = frame / rate;
			expect(formatRulerLabel({ timeInSeconds: time, fps })).toBe(
				legacyLabel(time, rate),
			);
		}
	}
});