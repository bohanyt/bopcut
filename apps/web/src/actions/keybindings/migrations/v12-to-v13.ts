import { getPersistedKeybindingsState } from "../persisted-state";

// A deselects everything, unless the user put A on another action.
export function v12ToV13({ state }: { state: unknown }): unknown {
	const v12 = getPersistedKeybindingsState({ state });
	if (!v12 || v12.keybindings.a) return state;
	return { ...v12, keybindings: { ...v12.keybindings, a: "deselect-all" } };
}
