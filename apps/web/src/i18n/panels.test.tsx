import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaDragOverlay } from "@/components/editor/panels/assets/drag-overlay";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import { textStyleParams } from "@/text/style";
import { LocaleProvider } from "./provider";

test.each([
	["en", "Processing your files (46%)", "Highlight active word"],
	["id", "Memproses file (46%)", "Sorot kata aktif"],
] as const)("renders editor panel copy in %s", (locale, progress, property) => {
	const param = textStyleParams.find(({ key }) => key === "caption.activeEnabled");
	if (!param) throw new Error("Missing caption property");

	const html = renderToStaticMarkup(
		<LocaleProvider initialLocale={locale}>
			<MediaDragOverlay isVisible isProcessing progress={46} />
			<PropertyParamField
				param={param}
				value={true}
				onPreview={() => {}}
				onCommit={() => {}}
			/>
		</LocaleProvider>,
	);

	expect(html).toContain(progress);
	expect(html).toContain(property);
});
