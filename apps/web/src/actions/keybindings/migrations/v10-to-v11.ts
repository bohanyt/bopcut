import { getPersistedKeybindingsState } from "../persisted-state";

// U expands or collapses the selected clips' keyframes, unless the user put U on another action.
export function v10ToV11({ state }: { state: unknown }): unknown {
	const v10 = getPersistedKeybindingsState({ state });
	if (!v10 || v10.keybindings.u) return state;
	return { ...v10, keybindings: { ...v10.keybindings, u: "toggle-keyframe-lanes" } };
}
