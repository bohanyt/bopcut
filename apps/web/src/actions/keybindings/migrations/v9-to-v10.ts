import { getPersistedKeybindingsState } from "../persisted-state";

// E takes the action of W, and W splits only the selection. Keys the user changed keep their action.
export function v9ToV10({ state }: { state: unknown }): unknown {
	const v9 = getPersistedKeybindingsState({ state });
	if (!v9 || v9.keybindings.w !== "split-right" || v9.keybindings.e) return state;
	return { ...v9, keybindings: { ...v9.keybindings, e: "split-right", w: "split-selected" } };
}
