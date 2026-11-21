import { expect, test } from "bun:test";
import { PANEL_CONFIG } from "@/panels/layout";
import { createPanelStore } from "./panel-store";

function createPreferenceStorage() {
	const entries = new Map<string, string>();
	return {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => entries.set(key, value),
		removeItem: (key: string) => entries.delete(key),
	};
}

test("defaults to the classic layout with both sets of panel sizes", () => {
	const store = createPanelStore(createPreferenceStorage);
	expect(store.getState().layout).toBe("classic");
	expect(store.getState().panels).toEqual(PANEL_CONFIG.panels);
	expect(store.getState().rightPanels).toEqual(PANEL_CONFIG.rightPanels);
});

test("restores the layout choice and sizes independently on reload", () => {
	const storage = createPreferenceStorage();
	const store = createPanelStore(() => storage);
	const { setLayout, setPanels, setRightPanel } = store.getState();

	setPanels({ preview: 40, tools: 30, properties: 30 });
	setLayout("preview-right");
	setRightPanel({ panel: "preview", size: 37 });
	setRightPanel({ panel: "timeline", size: 42 });
	setLayout("classic");
	expect(store.getState().panels.preview).toBe(40);
	setLayout("preview-right");

	const restored = createPanelStore(() => storage).getState();
	expect(restored.layout).toBe("preview-right");
	expect(restored.rightPanels).toEqual({ preview: 37, tools: 50, timeline: 42 });
	expect(restored.panels).toEqual({
		...PANEL_CONFIG.panels,
		preview: 40,
		tools: 30,
		properties: 30,
	});
});

test("migrates the existing panel sizes to the classic layout", () => {
	const storage = createPreferenceStorage();
	const panels = { tools: 30, preview: 45, properties: 25, mainContent: 60, timeline: 40 };
	storage.setItem("panel-sizes", JSON.stringify({ version: 2, state: { panels } }));

	const store = createPanelStore(() => storage);
	expect(store.getState().layout).toBe("classic");
	expect(store.getState().panels).toEqual(panels);
	expect(store.getState().rightPanels).toEqual(PANEL_CONFIG.rightPanels);
});

test("migrates older preferences with flat panel sizes", () => {
	const storage = createPreferenceStorage();
	storage.setItem(
		"panel-sizes",
		JSON.stringify({ version: 1, state: { toolsPanel: 30, previewPanel: 45 } }),
	);

	const store = createPanelStore(() => storage);
	expect(store.getState().layout).toBe("classic");
	expect(store.getState().panels).toEqual({ ...PANEL_CONFIG.panels, tools: 30, preview: 45 });
});
