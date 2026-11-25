import { en } from "@/i18n/en";
import type { ShortcutKey } from "@/actions/keybinding";
import type { TActionWithOptionalArgs } from "./types";

export type TActionCategory =
	| "playback"
	| "navigation"
	| "editing"
	| "selection"
	| "history"
	| "timeline"
	| "controls"
	| "assets";

export interface TActionBaseDefinition {
	description: string;
	category: TActionCategory;
	args?: Record<string, unknown>;
}

export interface TActionDefinition extends TActionBaseDefinition {
	defaultShortcuts?: readonly ShortcutKey[];
}

export const ACTIONS = {
	"record-voice-over": {
		description: en["shortcuts.action.record-voice-over"],
		category: "timeline",
	},
	"toggle-play": {
		description: en["shortcuts.action.toggle-play"],
		category: "playback",
	},
	"stop-playback": {
		description: en["shortcuts.action.stop-playback"],
		category: "playback",
	},
	"seek-forward": {
		description: en["shortcuts.action.seek-forward"],
		category: "playback",
		args: { seconds: "number" },
	},
	"seek-backward": {
		description: en["shortcuts.action.seek-backward"],
		category: "playback",
		args: { seconds: "number" },
	},
	"frame-step-forward": {
		description: en["shortcuts.action.frame-step-forward"],
		category: "navigation",
	},
	"frame-step-backward": {
		description: en["shortcuts.action.frame-step-backward"],
		category: "navigation",
	},
	"jump-forward": {
		description: en["shortcuts.action.jump-forward"],
		category: "navigation",
		args: { seconds: "number" },
	},
	"jump-backward": {
		description: en["shortcuts.action.jump-backward"],
		category: "navigation",
		args: { seconds: "number" },
	},
	"goto-start": {
		description: en["shortcuts.action.goto-start"],
		category: "navigation",
	},
	"goto-end": {
		description: en["shortcuts.action.goto-end"],
		category: "navigation",
	},
	split: {
		description: en["shortcuts.action.split"],
		category: "editing",
	},
	"split-selected": {
		description: en["shortcuts.action.split-selected"],
		category: "editing",
	},
	"split-left": {
		description: en["shortcuts.action.split-left"],
		category: "editing",
	},
	"split-right": {
		description: en["shortcuts.action.split-right"],
		category: "editing",
	},
	"delete-selected": {
		description: en["shortcuts.action.delete-selected"],
		category: "editing",
	},
	"copy-selected": {
		description: en["shortcuts.action.copy-selected"],
		category: "editing",
	},
	"paste-copied": {
		description: en["shortcuts.action.paste-copied"],
		category: "editing",
	},
	"toggle-snapping": {
		description: en["shortcuts.action.toggle-snapping"],
		category: "editing",
	},
	"toggle-ripple-editing": {
		description: en["shortcuts.action.toggle-ripple-editing"],
		category: "editing",
	},
	"toggle-source-audio": {
		description: en["shortcuts.action.toggle-source-audio"],
		category: "editing",
	},
	"select-all": {
		description: en["shortcuts.action.select-all"],
		category: "selection",
	},
	"cancel-interaction": {
		description: en["shortcuts.action.cancel-interaction"],
		category: "controls",
	},
	"deselect-all": {
		description: en["shortcuts.action.deselect-all"],
		category: "selection",
	},
	"duplicate-selected": {
		description: en["shortcuts.action.duplicate-selected"],
		category: "selection",
	},
	"toggle-elements-muted-selected": {
		description: en["shortcuts.action.toggle-elements-muted-selected"],
		category: "selection",
	},
	"toggle-elements-visibility-selected": {
		description: en["shortcuts.action.toggle-elements-visibility-selected"],
		category: "selection",
	},
	"create-compound": {
		description: en["shortcuts.action.create-compound"],
		category: "editing",
	},
	"break-apart-compound": {
		description: en["shortcuts.action.break-apart-compound"],
		category: "editing",
	},
	"exit-compound": {
		description: en["shortcuts.action.exit-compound"],
		category: "navigation",
	},
	"toggle-bookmark": {
		description: en["shortcuts.action.toggle-bookmark"],
		category: "timeline",
	},
	undo: {
		description: en["shortcuts.action.undo"],
		category: "history",
	},
	redo: {
		description: en["shortcuts.action.redo"],
		category: "history",
	},
	"remove-media-asset": {
		description: en["shortcuts.action.remove-media-asset"],
		category: "assets",
		args: { projectId: "string", assetId: "string" },
	},
	"remove-media-assets": {
		description: en["shortcuts.action.remove-media-assets"],
		category: "assets",
		args: { projectId: "string", assetIds: "string[]" },
	},
} as const satisfies Record<string, TActionBaseDefinition>;

export type TAction = keyof typeof ACTIONS;

const ACTIONS_REQUIRING_ARGS = {
	"remove-media-asset": true,
	"remove-media-assets": true,
} satisfies Record<Exclude<TAction, TActionWithOptionalArgs>, true>;

export function isActionWithOptionalArgs(
	value: string,
): value is TActionWithOptionalArgs {
	return (
		Object.hasOwn(ACTIONS, value) &&
		!Object.hasOwn(ACTIONS_REQUIRING_ARGS, value)
	);
}

const ACTION_DEFAULT_SHORTCUTS = [
	["record-voice-over", ["shift+r"]],
	["toggle-play", ["space", "k"]],
	["seek-forward", ["l"]],
	["seek-backward", ["j"]],
	["frame-step-forward", ["right"]],
	["frame-step-backward", ["left"]],
	["jump-forward", ["shift+right"]],
	["jump-backward", ["shift+left"]],
	["goto-start", ["home", "enter"]],
	["goto-end", ["end"]],
	["split", ["s"]],
	["split-selected", ["w"]],
	["split-left", ["q"]],
	["split-right", ["e"]],
	["delete-selected", ["backspace", "delete"]],
	["copy-selected", ["ctrl+c"]],
	["paste-copied", ["ctrl+v"]],
	["toggle-snapping", ["n"]],
	["select-all", ["ctrl+a"]],
	["cancel-interaction", ["escape"]],
	["duplicate-selected", ["ctrl+d"]],
	["create-compound", ["alt+g"]],
	["break-apart-compound", ["alt+shift+g"]],
	["undo", ["ctrl+z"]],
	["redo", ["ctrl+shift+z", "ctrl+y"]],
] as const satisfies ReadonlyArray<
	readonly [TActionWithOptionalArgs, readonly ShortcutKey[]]
>;

const ACTION_DEFAULT_SHORTCUTS_BY_ACTION = new Map<
	TAction,
	readonly ShortcutKey[]
>(ACTION_DEFAULT_SHORTCUTS);

export function getActionDefinition({
	action,
}: {
	action: TAction;
}): TActionDefinition {
	return {
		...ACTIONS[action],
		defaultShortcuts: ACTION_DEFAULT_SHORTCUTS_BY_ACTION.get(action),
	};
}

export function getDefaultShortcuts(): Map<
	ShortcutKey,
	TActionWithOptionalArgs
> {
	const shortcuts = new Map<ShortcutKey, TActionWithOptionalArgs>();

	for (const [action, defaultShortcuts] of ACTION_DEFAULT_SHORTCUTS) {
		for (const shortcut of defaultShortcuts) {
			shortcuts.set(shortcut, action);
		}
	}

	return shortcuts;
}
