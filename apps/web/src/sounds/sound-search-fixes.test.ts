import { beforeEach, expect, test } from "bun:test";
import { parseSoundSearchParams } from "@/sounds/search-params";
import { useSoundsStore } from "@/sounds/sounds-store";
import type { SoundEffect } from "@/sounds/types";
import { appendSoundsPage } from "@/sounds/use-sound-search";

const sound = (id: number) => ({ id, name: `Sound ${id}` }) as SoundEffect;

beforeEach(() => {
	useSoundsStore.setState({ topSoundEffects: [sound(1)], searchResults: [sound(10)], currentPage: 1, hasNextPage: true, totalCount: 0 });
});

test("loading the next page appends to the top sounds or the search results", () => {
	expect(() => appendSoundsPage({ data: { results: [sound(2)], next: "page=3", count: 40 }, query: "", page: 2 })).not.toThrow();
	expect(useSoundsStore.getState()).toMatchObject({ currentPage: 2, hasNextPage: true, totalCount: 40 });
	expect(useSoundsStore.getState().topSoundEffects.map(({ id }) => id)).toEqual([1, 2]);
	appendSoundsPage({ data: { results: [sound(11)], next: null, count: 2 }, query: "boom", page: 2 });
	expect(useSoundsStore.getState().searchResults.map(({ id }) => id)).toEqual([10, 11]);
	expect(useSoundsStore.getState().hasNextPage).toBe(false);
});

test("the commercial-only setting is read from the request, and false means false", () => {
	const parse = (query: string) => parseSoundSearchParams(new URLSearchParams(query));
	expect(parse("commercial_only=false").data?.commercial_only).toBe(false);
	expect(parse("commercial_only=true").data?.commercial_only).toBe(true);
	expect(parse("").data?.commercial_only).toBe(true);
	expect(parse("commercial_only=maybe").success).toBe(false);
});

test("switching the commercial-only filter loads the top sounds and the current search again", () => {
	useSoundsStore.setState({ showCommercialOnly: true, hasLoaded: true, lastSearchQuery: "boom" });
	useSoundsStore.getState().toggleCommercialFilter();
	expect(useSoundsStore.getState()).toMatchObject({ showCommercialOnly: false, hasLoaded: false, lastSearchQuery: "" });
});
