import { getPersistedKeybindingsState } from "../persisted-state";

// Shift+] and Shift+[ select beside the playhead on the selected clips' tracks, unless the user put those keys on other actions.
export function v14ToV15({ state }: { state: unknown }): unknown {
	const v14 = getPersistedKeybindingsState({ state });
	if (!v14) return state;
	const added = { "shift+]": "select-right-on-selected-tracks", "shift+[": "select-left-on-selected-tracks" };
	const free = Object.fromEntries(Object.entries(added).filter(([key]) => !v14.keybindings[key]));
	return { ...v14, keybindings: { ...v14.keybindings, ...free } };
}
