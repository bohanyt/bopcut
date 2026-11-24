import { getPersistedKeybindingsState } from "../persisted-state";

export function v8ToV9({ state }: { state: unknown }): unknown {
	const v8 = getPersistedKeybindingsState({ state });
	if (!v8 || v8.keybindings["shift+r"]) return state;
	return { ...v8, keybindings: { ...v8.keybindings, "shift+r": "record-voice-over" } };
}
