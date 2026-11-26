import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FontPicker, typedFamilyToOffer } from "@/components/ui/font-picker";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false,
}));
const { PropertyParamField } = await import("@/components/editor/panels/properties/components/property-param-field");
const { getBuiltInElementParams } = await import("@/params/registry");
const textParam = (key: string) => getBuiltInElementParams({ type: "text" }).find((param) => param.key === key)!;

test("the font picker trigger is named with its field and font", () => {
	const html = renderToStaticMarkup(<FontPicker label="Font Family" defaultValue="Inter" />);
	expect(html).toContain('aria-label="Font Family: Inter"');
});

test("a family the font list lacks is offered as typed; a listed one (any case) is not", () => {
	const fontNames = ["Inter", "Roboto"];
	expect(typedFamilyToOffer({ search: "  My Studio Font ", fontNames })).toBe("My Studio Font");
	expect(typedFamilyToOffer({ search: "roboto", fontNames })).toBeNull();
	expect(typedFamilyToOffer({ search: "rob", fontNames })).toBe("rob");
	expect(typedFamilyToOffer({ search: "   ", fontNames })).toBeNull();
});

test("text properties use the font picker for the font, and name their switches, selects, colors and text", () => {
	const render = (key: string, value: unknown) =>
		renderToStaticMarkup(
			<PropertyParamField param={textParam(key)} value={value as never} onPreview={() => {}} onCommit={() => {}} />,
		);
	const font = render("fontFamily", "Inter");
	expect(font).toContain('aria-haspopup="dialog"');
	expect(font).toContain(': Inter"');
	expect(font).not.toContain("<input");
	expect(render("background.enabled", true)).toMatch(/role="switch"[^>]*aria-label="[^"]+"|aria-label="[^"]+"[^>]*role="switch"/);
	expect(render("textAlign", "center")).toMatch(/role="combobox"[^>]*aria-label="[^"]+"|aria-label="[^"]+"[^>]*role="combobox"/);
	expect(render("color", "#ffffff")).toMatch(/<input[^>]*aria-label="[^"]+"/);
	expect(render("content", "Halo")).toMatch(/<textarea[^>]*aria-label="[^"]+"/);
});
