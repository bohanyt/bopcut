import { describe, expect, test } from "bun:test";
import type { StickerItem, StickerSearchResult } from "../types";
import { mergeSearchResults } from "../index";

function sticker(id: string): StickerItem {
	return {
		id,
		provider: "test",
		name: id,
		previewUrl: "",
		metadata: {},
	};
}

function result(
	items: StickerItem[],
	total: number,
	hasMore = false,
): StickerSearchResult {
	return { items, total, hasMore };
}

describe("mergeSearchResults", () => {
	test("deduplicates totals across providers", () => {
		const merged = mergeSearchResults({
			results: [
				result([sticker("a"), sticker("b"), sticker("c")], 3),
				result([sticker("c"), sticker("d"), sticker("e")], 3),
			],
		});
		expect(merged.items).toHaveLength(5);
		expect(merged.total).toBe(5);

		const mergedWide = mergeSearchResults({
			results: [
				result(
					[sticker("a"), sticker("b"), sticker("shared")],
					10,
				),
				result([sticker("shared"), sticker("x"), sticker("y")], 3),
			],
		});
		expect(mergedWide.total).toBe(12);
	});

	test("single result is unchanged", () => {
		const single = result([sticker("only")], 1, true);
		expect(mergeSearchResults({ results: [single] })).toEqual(single);
	});
});