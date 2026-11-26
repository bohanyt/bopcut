import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AudioItem, SoundEffectsView } from "@/sounds/components/assets-view";
import { useSoundsStore } from "@/sounds/sounds-store";
import type { SoundEffect } from "@/sounds/types";

let dom: Window;
let root: Root;
let restoreGlobals: () => void;
const initialStore = useSoundsStore.getState();
const realFetch = globalThis.fetch;

const sound = (id: number): SoundEffect => ({
	id, name: `Sound ${id}`, description: "", url: "", previewUrl: `https://sounds.test/${id}.mp3`, downloadUrl: "",
	duration: 1, filesize: 0, type: "audio", channels: 0, bitrate: 0, bitdepth: 0, samplerate: 0,
	username: "someone", tags: [], license: "CC0", created: "", downloads: 0, rating: 0, ratingCount: 0,
});

beforeEach(async () => {
	dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		navigator: dom.navigator,
		HTMLElement: dom.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
	restoreGlobals = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	// Other test files in the same run leave sounds in the shared store. The saved sounds count as
	// loaded already: no storage in these tests.
	useSoundsStore.setState({
		topSoundEffects: [], isLoading: false, error: null, hasLoaded: false, showCommercialOnly: true,
		searchQuery: "", searchResults: [], isSearching: false, searchError: null, lastSearchQuery: "",
		scrollPosition: 0, currentPage: 1, hasNextPage: false, totalCount: 0, isLoadingMore: false,
		savedSounds: [], isSavedSoundsLoaded: true, loadSavedSounds: async () => {},
	});
	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.body.appendChild(dom.document.createElement("div")) as unknown as HTMLElement);
});

afterEach(async () => {
	await act(async () => root.unmount());
	await dom.close();
	restoreGlobals();
	globalThis.fetch = realFetch;
	useSoundsStore.setState(initialStore, true);
});

const query = (selector: string) => dom.document.querySelector(selector) as unknown as HTMLElement | null;
const click = (element: HTMLElement | null) =>
	element!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the add and save buttons of a sound work, and a pending add cannot be started twice", async () => {
	let finishAdd: (added: boolean) => void = () => {};
	const addSoundToTimeline = mock(() => new Promise<boolean>((resolve) => { finishAdd = resolve; }));
	const toggleSavedSound = mock(async () => {});
	useSoundsStore.setState({ addSoundToTimeline, toggleSavedSound });
	await act(async () => root.render(<AudioItem sound={sound(1)} isPlaying={false} onPlay={() => {}} />));

	const add = query("button[aria-label='Add Sound 1 at the playhead']");
	await act(async () => click(add));
	await act(async () => click(add));
	expect(addSoundToTimeline).toHaveBeenCalledTimes(1);
	expect(add!.hasAttribute("disabled")).toBe(true);
	await act(async () => finishAdd(true));
	expect(add!.hasAttribute("disabled")).toBe(false);

	await act(async () => click(query("button[aria-label='Save Sound 1']")));
	expect(toggleSavedSound).toHaveBeenCalledTimes(1);
	await act(async () => useSoundsStore.setState({ savedSounds: [{ ...sound(1), savedAt: "" } as never] }));
	expect(query("button[aria-label='Remove Sound 1 from saved']")?.getAttribute("aria-pressed")).toBe("true");
});

test("scrolling the sound effects keeps the position without a store write per scroll event", async () => {
	useSoundsStore.setState({ hasLoaded: true, topSoundEffects: Array.from({ length: 50 }, (_, index) => sound(index + 1)) });
	await act(async () => root.render(<SoundEffectsView />));
	let writes = 0;
	const unsubscribe = useSoundsStore.subscribe(() => {
		writes += 1;
	});
	const list = query(".scrollbar-thin");
	for (const top of [100, 200, 300]) {
		list!.scrollTop = top;
		await act(async () => {
			list!.dispatchEvent(new dom.Event("scroll") as unknown as Event);
		});
	}
	expect(writes).toBe(0);
	await act(async () => root.render(<div />));
	unsubscribe();
	expect(useSoundsStore.getState().scrollPosition).toBe(300);
});

test("a failed load of the sound effects says so and Retry loads them", async () => {
	let ok = false;
	const fetchMock = mock(async () =>
		ok ? Response.json({ results: [sound(7)], next: null, count: 1 }) : new Response("down", { status: 503 }));
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	await act(async () => root.render(<SoundEffectsView />));
	await act(() => wait(150));
	expect(query("[role=alert]")?.textContent).toContain("Failed to load sounds");
	expect(dom.document.body.textContent).not.toContain("No sounds available");

	ok = true;
	await act(async () => click([...dom.document.querySelectorAll("[role=alert] button")][0] as unknown as HTMLElement));
	await act(() => wait(150));
	expect(fetchMock).toHaveBeenCalledTimes(2);
	expect(query("[role=alert]")).toBeNull();
	expect(dom.document.body.textContent).toContain("Sound 7");
});
