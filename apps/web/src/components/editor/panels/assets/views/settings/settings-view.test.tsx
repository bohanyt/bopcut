import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorCore } from "@/core";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { SettingsView } from "./index";

test("custom dimension fields are outside the selection buttons", () => {
	const date = new Date(0);
	const getActive = spyOn(EditorCore.getInstance().project, "getActive").mockReturnValue({
		metadata: {
			id: "project",
			name: "Project",
			duration: ZERO_MEDIA_TIME,
			createdAt: date,
			updatedAt: date,
		},
		scenes: [],
		currentSceneId: "scene",
		version: 1,
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			canvasSizeMode: "custom",
			lastCustomCanvasSize: { width: 3840, height: 2160 },
			background: { type: "color", color: "#000000" },
		},
	});

	try {
		const markup = renderToStaticMarkup(<SettingsView />);
		const width = 'input[aria-label="Canvas width"]';
		const height = 'input[aria-label="Canvas height"]';
		const labels: (string | null)[] = [];
		const nestedLabels: (string | null)[] = [];
		new HTMLRewriter()
			.on(`${width}, ${height}`, {
				element(field) {
					labels.push(field.getAttribute("aria-label"));
				},
			})
			.on(`button ${width}, button ${height}`, {
				element(field) {
					nestedLabels.push(field.getAttribute("aria-label"));
				},
			})
			.transform(markup);

		expect(labels).toEqual(["Canvas width", "Canvas height"]);
		expect(nestedLabels).toEqual([]);
	} finally {
		getActive.mockRestore();
	}
});
