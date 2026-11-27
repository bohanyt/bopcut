import { getPersistedKeybindingsState } from "../persisted-state";

// Ctrl+X cuts, ] and [ select the clips right and left of the playhead, unless the user put those keys on other actions.
export function v11ToV12({ state }: { state: unknown }): unknown {
	const v11 = getPersistedKeybindingsState({ state });
	if (!v11) return state;
	const added = { "ctrl+x": "cut-selected", "]": "select-right-of-playhead", "[": "select-left-of-playhead" };
	const free = Object.fromEntries(Object.entries(added).filter(([key]) => !v11.keybindings[key]));
	return { ...v11, keybindings: { ...v11.keybindings, ...free } };
}
