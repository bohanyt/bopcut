import { describe, expect, test } from "bun:test";
import type { TScene } from "@/timeline";
import { ensureMainScene } from "@/timeline/scenes";
import { fixture, scene } from "./compound-fixtures";

describe("ensureMainScene", () => {
	test("keeps a single main, demotes extra mains, prepends when none", () => {
		const tracks = fixture()[0].tracks;

		const first = scene("a", tracks, { isMain: true });
		const second = scene("b", tracks, { isMain: true });
		const twoMains = [first, second];
		const fromTwo = ensureMainScene({ scenes: twoMains });
		expect(fromTwo[0]).toBe(first);
		expect(fromTwo[0].isMain).toBe(true);
		expect(fromTwo[1].isMain).toBe(false);
		expect(fromTwo[1]).toEqual({ ...second, isMain: false });

		const oneMain = fixture();
		const fromOne = ensureMainScene({ scenes: oneMain });
		expect(fromOne).toBe(oneMain);

		const noneMain: TScene[] = [{ ...scene("x", tracks), isMain: false }];
		const fromNone = ensureMainScene({ scenes: noneMain });
		expect(fromNone.length).toBe(noneMain.length + 1);
		expect(fromNone[0].isMain).toBe(true);
		expect(fromNone[0].name).toBe("Main scene");
		expect(fromNone.slice(1)).toEqual(noneMain);
	});
});