import { getPersistedKeybindingsState } from "../persisted-state";

// J, K and L become the shuttle, and the 1 s steps move to Shift+J and Shift+L, on the keys that still
// do what they did by default. Keys the user put on other actions keep them.
export function v13ToV14({ state }: { state: unknown }): unknown {
	const v13 = getPersistedKeybindingsState({ state });
	if (!v13) return state;
	const keys = { ...v13.keybindings };
	const move = (key: string, old: string, shuttle: string, stepKey: string) => {
		if (keys[key] !== old) return;
		keys[key] = shuttle;
		if (!keys[stepKey]) keys[stepKey] = old;
	};
	move("l", "seek-forward", "shuttle-forward", "shift+l");
	move("j", "seek-backward", "shuttle-backward", "shift+j");
	if (keys.k === "toggle-play") keys.k = "shuttle-stop";
	return { ...v13, keybindings: keys };
}
