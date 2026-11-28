export function downloadBlob({
	blob,
	filename,
}: {
	blob: Blob;
	filename: string;
}): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

export function findScrollParent({
	element,
}: {
	element: HTMLElement;
}): HTMLElement | null {
	let parent = element.parentElement;
	while (parent) {
		const { overflow, overflowX } = window.getComputedStyle(parent);
		if (/auto|scroll/.test(overflow + overflowX)) return parent;
		parent = parent.parentElement;
	}
	return null;
}

export function isTypableDOMElement({
	element,
}: {
	element: HTMLElement;
}): boolean {
	if (element.isContentEditable) return true;

	if (element.tagName === "INPUT") {
		return !(element as HTMLInputElement).disabled;
	}

	if (element.tagName === "TEXTAREA") {
		return !(element as HTMLTextAreaElement).disabled;
	}

	return false;
}

const ACTIVATE_KEYS: ReadonlySet<string> = new Set(["space", "enter"]);
const MOVE_KEYS: ReadonlySet<string> = new Set(["up", "down", "left", "right", "home", "end"]);
/** Controls that choose among options: arrows move, and typing a letter finds an option. */
const CHOOSING_ROLES: ReadonlySet<string> = new Set([
	"combobox", "listbox", "option", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "tree", "treeitem",
]);
/** Controls whose value or place the arrows change. */
const MOVING_ROLES: ReadonlySet<string> = new Set(["slider", "spinbutton", "tab", "tablist", "radio", "radiogroup", "separator"]);
const PRESSED_ROLES: ReadonlySet<string> = new Set(["button", "link", "checkbox", "switch"]);

function roleOf(element: Element): string {
	const role = element.getAttribute("role");
	if (role) return role;
	if (element.tagName === "BUTTON" || element.tagName === "SUMMARY") return "button";
	if (element.tagName === "A" && element.hasAttribute("href")) return "link";
	if (element.tagName === "SELECT") return "combobox";
	return "";
}

/**
 * Whether a key without modifiers belongs to the focused control, so an editor shortcut leaves it:
 * Space and Enter press a button, and open or choose in a list; arrows move in a list, slider or
 * tabs; a letter finds an option. Only for a control reached with the keyboard: after a click,
 * Space still plays.
 */
export function isKeyForFocusedControl({ element, key }: { element: Element; key: string }): boolean {
	let byKeyboard = false;
	try { byKeyboard = element.matches(":focus-visible"); } catch { return false; }
	if (!byKeyboard) return false;
	const role = roleOf(element);
	if (CHOOSING_ROLES.has(role)) return ACTIVATE_KEYS.has(key) || MOVE_KEYS.has(key) || /^[a-z0-9]$/.test(key);
	if (MOVING_ROLES.has(role)) return ACTIVATE_KEYS.has(key) || MOVE_KEYS.has(key);
	return PRESSED_ROLES.has(role) && ACTIVATE_KEYS.has(key);
}

/** Inputs with no text of their own: Ctrl+A there would select the page instead. */
const TEXTLESS_INPUT_TYPES: ReadonlySet<string> = new Set([
	"button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit",
]);

/** A field whose own text Ctrl+A selects. */
export function hasSelectableText({ element }: { element: HTMLElement }): boolean {
	if (!isTypableDOMElement({ element })) return false;
	return !(element instanceof HTMLInputElement) || !TEXTLESS_INPUT_TYPES.has(element.type);
}

// Pointer handlers run before the browser's default focus change. A field's
// blur commit must finish before the new gesture starts using timeline tracks.
export function finishFocusedField(target: Element): void {
	const focused = target.ownerDocument.activeElement as HTMLElement | null;
	if (focused && typeof focused.blur === "function" && isTypableDOMElement({ element: focused })) {
		focused.blur();
	}
}
