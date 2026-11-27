import { expect, test } from "bun:test";
import ts from "typescript";

const surfaces = [
	"components/landing/hero.tsx",
	"home/accounts-tab.tsx",
	"reframe/components/split-layout-dialog.tsx",
	"reframe/components/face-pick.tsx",
	"project/components/project-mode-dialog.tsx",
	"home/agent-tab.tsx",
	"home/home-page.tsx",
	"preview/components/context-menu.tsx",
	"preview/components/guide-popover.tsx",
	"services/storage/components/storage-persistence-dialog.tsx",
];

test("the landing hero, preview menus and storage prompts use message keys for JSX text", async () => {
	const offenders: string[] = [];
	for (const path of surfaces) {
		const source = await Bun.file(new URL("../" + path, import.meta.url)).text();
		const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
		const visit = (node: ts.Node) => {
			if (ts.isJsxText(node) && /[A-Za-z]{2}/.test(node.getText(tree))) {
				const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
				offenders.push(path + ":" + (line + 1));
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	expect(offenders).toEqual([]);
});
