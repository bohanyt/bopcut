import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (file: string) => readFileSync(path.join(import.meta.dir, "..", file), "utf8");
/** The declarations of the rule with exactly this selector. */
function rule({ css, selector }: { css: string; selector: string }) {
	const start = css.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`No rule for ${selector}`);
	return css.slice(start, css.indexOf("}", start));
}

// happy-dom does not compute user-select, so this reads the stylesheet.
test("the editor's labels and panels cannot be selected as text, its fields can", () => {
	const css = read("app/globals.css");
	expect(rule({ css, selector: ".editor-chrome" })).toContain(" user-select: none;");
	expect(rule({ css, selector: '.editor-chrome :is(input, textarea, [contenteditable]:not([contenteditable="false"]))' })).toContain(" user-select: text;");
	expect(read("app/editor/[project_id]/page.tsx")).toContain('<div className="editor-chrome ');
});
