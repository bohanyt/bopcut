import { expect, test } from "bun:test";
import { nextShuttleRate, shuttleLabel } from "./shuttle";

test("L plays at 1×, then 2× and 4×; J does the same backwards; the other direction starts again at 1×", () => {
	const after = (presses: (1 | -1)[]) => presses.reduce<{ playing: boolean; rate: number }>(
		(state, direction) => ({ playing: true, rate: nextShuttleRate({ ...state, direction }) }), { playing: false, rate: 1 }).rate;
	expect([after([1]), after([1, 1]), after([1, 1, 1]), after([1, 1, 1, 1])]).toEqual([1, 2, 4, 4]);
	expect([after([-1]), after([-1, -1]), after([-1, -1, -1])]).toEqual([-1, -2, -4]);
	expect(after([1, 1, -1])).toBe(-1);
	expect(after([-1, -1, 1])).toBe(1);
	// Stopped (K), the next L starts at 1× again.
	expect(nextShuttleRate({ playing: false, rate: 4, direction: 1 })).toBe(1);
	expect([shuttleLabel(2), shuttleLabel(-1)]).toEqual(["2×", "−1×"]);
});
