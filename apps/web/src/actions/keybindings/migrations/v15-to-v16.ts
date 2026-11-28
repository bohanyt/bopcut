import { getPersistedKeybindingsState } from "../persisted-state";

// Ctrl+Shift+V pastes the copied clip's changed settings, unless the user put that key on another action.
export function v15ToV16({ state }: { state: unknown }): unknown {
	const v15 = getPersistedKeybindingsState({ state });
	if (!v15 || v15.keybindings["ctrl+shift+v"]) return state;
	return { ...v15, keybindings: { ...v15.keybindings, "ctrl+shift+v": "paste-attributes" } };
}
