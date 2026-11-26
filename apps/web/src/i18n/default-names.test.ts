import { afterEach, expect, test } from "bun:test";
import { buildNewProject } from "@/project/create";
import { getNextCompoundName } from "@/timeline/compound";
import type { TScene } from "@/timeline";

const original = Object.getOwnPropertyDescriptor(globalThis, "document");
const setLanguage = (lang: string) =>
	Object.defineProperty(globalThis, "document", { value: { documentElement: { lang } }, configurable: true, writable: true });
afterEach(() => {
	if (original) Object.defineProperty(globalThis, "document", original);
	else Reflect.deleteProperty(globalThis, "document");
});

const compound = (name: string) => ({ id: name, name, isMain: false, kind: "compound" }) as unknown as TScene;

test("new names follow the editor language", () => {
	setLanguage("id");
	expect(buildNewProject({ name: "p" }).scenes[0].name).toBe("Scene utama");
	// Numbering continues across names made in either language.
	expect(getNextCompoundName({ scenes: [compound("Compound clip 2")] })).toBe("Klip gabungan 3");
	setLanguage("en");
	expect(buildNewProject({ name: "p" }).scenes[0].name).toBe("Main scene");
	expect(getNextCompoundName({ scenes: [compound("Klip gabungan 4")] })).toBe("Compound clip 5");
});
