import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getDefaultShortcuts } from "@/actions";
import {
	decodePersistedKeybindingsState,
	migratePersistedKeybindingsState,
	parseImportedKeybindings,
	type DecodedKeybindingsState,
	serializeKeybindingsState,
} from "../persistence";

const ADDED_IN_12 = { "ctrl+x": "cut-selected", "]": "select-right-of-playhead", "[": "select-left-of-playhead" };

describe("keybinding persistence", () => {
	let warnSpy: ReturnType<typeof mock>;
	let originalWarn: typeof console.warn;

	beforeEach(() => {
		originalWarn = console.warn;
		warnSpy = mock(() => {});
		console.warn = warnSpy;
	});

	afterEach(() => {
		console.warn = originalWarn;
	});

	test("migrates legacy persisted keybindings before decoding them", () => {
		const migrated = migratePersistedKeybindingsState({
			state: {
				keybindings: {
					s: "split-selected",
					"ctrl+v": "paste-selected",
				},
				isCustomized: true,
			},
			fromVersion: 2,
		});

		const decoded = decodePersistedKeybindingsState({ state: migrated });
		expect(decoded).not.toBeNull();
		if (!decoded) throw new Error("Expected migrated keybindings to decode");

		expect(decoded.isCustomized).toBe(true);
		expect(decoded.keybindings.get("s")).toBe("split");
		expect(decoded.keybindings.get("ctrl+v")).toBe("paste-copied");
		expect(decoded.keybindings.get("escape")).toBe("cancel-interaction");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("saved shortcuts get Ctrl+X, [ and ] unless those keys do something else, and a custom bracket key is kept", () => {
		const migrated = migratePersistedKeybindingsState({
			state: { keybindings: { "ctrl+c": "copy-selected", "[": "split-left", "shift+]": "select-right-of-playhead" }, isCustomized: true },
			fromVersion: 11,
		});
		const decoded = decodePersistedKeybindingsState({ state: migrated });
		if (!decoded) throw new Error("Expected migrated keybindings to decode");
		expect(decoded.keybindings.get("ctrl+x")).toBe("cut-selected");
		expect(decoded.keybindings.get("]")).toBe("select-right-of-playhead");
		expect(decoded.keybindings.get("[")).toBe("split-left");
		expect(decoded.keybindings.get("shift+]")).toBe("select-right-of-playhead");
		// Saved again and read back (a reload), the bracket keys stay.
		const reread = decodePersistedKeybindingsState({ state: JSON.parse(JSON.stringify(serializeKeybindingsState(decoded))) });
		expect(reread?.keybindings.get("shift+]")).toBe("select-right-of-playhead");
		expect(reread?.keybindings.get("[")).toBe("split-left");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("filters invalid persisted entries at the boundary and warns", () => {
		const decoded = decodePersistedKeybindingsState({
			state: {
				keybindings: {
					space: "toggle-play",
					"shift+bogus": "toggle-play",
					"ctrl+v": "not-an-action",
				},
				isCustomized: false,
			},
		});

		expect(decoded).not.toBeNull();
		if (!decoded) throw new Error("Expected persisted keybindings to decode");

		expect(Array.from(decoded.keybindings.entries())).toEqual([
			["space", "toggle-play"],
		]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("keeps the current shortcuts when every saved entry is invalid", () => {
		// The caller keeps its current (default) shortcuts on null; an empty map would leave no shortcut at all.
		const decoded = decodePersistedKeybindingsState({
			state: { keybindings: { "shift+bogus": "toggle-play", "ctrl+v": "not-an-action" }, isCustomized: true },
		});
		expect(decoded).toBeNull();
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("returns null and warns when persisted shape is unrecognizable", () => {
		const decoded = decodePersistedKeybindingsState({ state: "garbage" });
		expect(decoded).toBeNull();
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("store merge decodes persisted keybindings like persistence boundary", () => {
		const current = {
			keybindings: new Map([["space", "toggle-play"] as const]),
			isCustomized: false,
		} satisfies DecodedKeybindingsState;
		const mergeLikeStore = (persisted: unknown) => {
			const decoded = decodePersistedKeybindingsState({ state: persisted });
			return decoded ? { ...current, ...decoded } : current;
		};

		expect(
			Array.from(
				mergeLikeStore({
					keybindings: { space: "toggle-play", "ctrl+x": "not-an-action" },
					isCustomized: true,
				}).keybindings.entries(),
			),
		).toEqual([["space", "toggle-play"]]);
		expect(
			mergeLikeStore({
				keybindings: { esc: "cancel-interaction" },
				isCustomized: false,
			}).keybindings.get("escape"),
		).toBe("cancel-interaction");
		expect(
			mergeLikeStore({
				keybindings: {
					esc: "deselect-all",
					escape: "cancel-interaction",
				},
				isCustomized: false,
			}).keybindings.get("escape"),
		).toBe("cancel-interaction");
		expect(mergeLikeStore("garbage").keybindings.get("space")).toBe(
			"toggle-play",
		);
	});

	test("round-trips actions that have no default shortcut", () => {
		// `stop-playback` is a valid `TActionWithOptionalArgs` but is not in the
		// defaults table; the validator must still accept it.
		const serialized = serializeKeybindingsState({
			keybindings: new Map([
				["space", "toggle-play"],
				["x", "stop-playback"],
				["b", "toggle-bookmark"],
			]),
			isCustomized: true,
		});

		const decoded = decodePersistedKeybindingsState({ state: serialized });
		expect(decoded).not.toBeNull();
		if (!decoded) throw new Error("Expected round-tripped keybindings");

		expect(decoded.keybindings.get("space")).toBe("toggle-play");
		expect(decoded.keybindings.get("x")).toBe("stop-playback");
		expect(decoded.keybindings.get("b")).toBe("toggle-bookmark");
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

describe("parseImportedKeybindings", () => {
	test("accepts a valid configuration", () => {
		const result = parseImportedKeybindings({
			config: {
				space: "toggle-play",
				x: "stop-playback",
			},
		});

		expect(result.get("space")).toBe("toggle-play");
		expect(result.get("x")).toBe("stop-playback");
	});

	test("throws on non-object input", () => {
		expect(() => parseImportedKeybindings({ config: null })).toThrow(
			/JSON object/,
		);
		expect(() => parseImportedKeybindings({ config: [] })).toThrow(
			/JSON object/,
		);
	});

	test("throws on non-string action values", () => {
		expect(() => parseImportedKeybindings({ config: { space: 42 } })).toThrow(
			/expected string/,
		);
	});

	test("throws on invalid shortcut keys", () => {
		expect(() =>
			parseImportedKeybindings({
				config: { "shift+bogus": "toggle-play" },
			}),
		).toThrow(/shift\+bogus/);
	});

	test("rejects actions requiring arguments and invalid modifier combinations", () => {
		expect(() =>
			parseImportedKeybindings({ config: { x: "remove-media-asset" } }),
		).toThrow(/remove-media-asset/);
		expect(() =>
			parseImportedKeybindings({ config: { "shift+ctrl+x": "split" } }),
		).toThrow(/shortcut/);
		expect(() =>
			parseImportedKeybindings({ config: { x: "toString" } }),
		).toThrow(/toString/);
	});

	test("throws on invalid actions", () => {
		expect(() =>
			parseImportedKeybindings({ config: { space: "not-an-action" } }),
		).toThrow(/not-an-action/);
	});
});

test("an older custom esc shortcut survives the migrations", () => {
	for (const fromVersion of [2, 4]) {
		const state = migratePersistedKeybindingsState({
			state: { keybindings: { esc: "undo" }, isCustomized: true },
			fromVersion,
		});
		expect(decodePersistedKeybindingsState({ state })?.keybindings.get("escape")).toBe("undo");
	}
});

describe("the split keys of version 10", () => {
	const migrate = (keybindings: Record<string, string>): Record<string, string> => Object.fromEntries(
		decodePersistedKeybindingsState({
			state: migratePersistedKeybindingsState({ state: { keybindings, isCustomized: true }, fromVersion: 9 }),
		})?.keybindings ?? [],
	);

	test("stored defaults become the new defaults", () => {
		const defaults = Object.fromEntries(getDefaultShortcuts());
		const { e: _, ...rest } = defaults;
		expect(migrate({ ...rest, w: "split-right" })).toEqual(defaults);
	});

	test("keys the user changed keep their action", () => {
		const cases: Record<string, string>[] = [
			{ w: "split-right", e: "undo" },
			{ w: "toggle-play" },
			{ e: "split-right" },
			{ s: "split-left", q: "split" },
			{},
		];
		// Version 11 adds U on top, version 12 Ctrl+X, [ and ].
		for (const changed of cases) expect(migrate(changed)).toEqual({ ...changed, u: "toggle-keyframe-lanes", ...ADDED_IN_12 });
	});
});

describe("the keyframe key of version 11", () => {
	const migrate = (keybindings: Record<string, string>): Record<string, string> => Object.fromEntries(
		decodePersistedKeybindingsState({
			state: migratePersistedKeybindingsState({ state: { keybindings, isCustomized: true }, fromVersion: 10 }),
		})?.keybindings ?? [],
	);

	test("U expands or collapses keyframes, unless the user put U on another action", () => {
		expect(migrate({ n: "toggle-snapping" })).toEqual({ n: "toggle-snapping", u: "toggle-keyframe-lanes", ...ADDED_IN_12 });
		expect(migrate({ u: "undo" })).toEqual({ u: "undo", ...ADDED_IN_12 });
	});
});
