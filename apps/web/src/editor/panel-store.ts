import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { PANEL_CONFIG } from "@/panels/layout";

export interface PanelSizes {
	tools: number;
	preview: number;
	properties: number;
	mainContent: number;
	timeline: number;
}

export type PanelId = keyof PanelSizes;
type EditorPanelLayout = "classic" | "preview-right";
type RightPanelSizes = Record<keyof typeof PANEL_CONFIG.rightPanels, number>;

interface PanelState {
	layout: EditorPanelLayout;
	panels: PanelSizes;
	rightPanels: RightPanelSizes;
	setLayout: (layout: EditorPanelLayout) => void;
	setRightPanel: (args: { panel: keyof RightPanelSizes; size: number }) => void;
	setPanel: (args: { panel: PanelId; size: number }) => void;
	setPanels: (sizes: Partial<PanelSizes>) => void;
	resetPanels: () => void;
}

type PanelPreferences = Pick<PanelState, "layout" | "panels" | "rightPanels">;

export const createPanelStore = (
	getStorage: () => StateStorage = () => window.localStorage,
) => create<PanelState>()(
	persist(
		(set) => ({
			...PANEL_CONFIG,
			layout: "classic",
			setLayout: (layout) => set({ layout }),
			setRightPanel: ({ panel, size }) =>
				set((state) => ({
					rightPanels: { ...state.rightPanels, [panel]: size },
				})),
			setPanel: ({ panel, size }) =>
				set((state) => ({
					panels: {
						...state.panels,
						[panel]: size,
					},
				})),
			setPanels: (sizes) =>
				set((state) => ({
					panels: {
						...state.panels,
						...sizes,
					},
				})),
			resetPanels: () => set({ ...PANEL_CONFIG }),
		}),
		{
			name: "panel-sizes",
			storage: createJSONStorage<PanelPreferences>(getStorage),
			version: 3,
			migrate: (persistedState) => {
				const state = persistedState as
					| {
							panels?: Partial<PanelSizes> | null;
							toolsPanel?: number;
							previewPanel?: number;
							propertiesPanel?: number;
							mainContent?: number;
							timeline?: number;
							tools?: number;
							preview?: number;
							properties?: number;
					  }
					| undefined
					| null;

				const defaults = { ...PANEL_CONFIG, layout: "classic" as const };
				if (!state) return defaults;

				if (state.panels && typeof state.panels === "object") {
					return {
						...defaults,
						panels: {
							...PANEL_CONFIG.panels,
							...state.panels,
						},
					};
				}

				return {
					...defaults,
					panels: {
						tools: state.tools ?? state.toolsPanel ?? PANEL_CONFIG.panels.tools,
						preview:
							state.preview ??
							state.previewPanel ??
							PANEL_CONFIG.panels.preview,
						properties:
							state.properties ??
							state.propertiesPanel ??
							PANEL_CONFIG.panels.properties,
						mainContent: state.mainContent ?? PANEL_CONFIG.panels.mainContent,
						timeline: state.timeline ?? PANEL_CONFIG.panels.timeline,
					},
				};
			},
			partialize: (state) => ({
				layout: state.layout,
				panels: state.panels,
				rightPanels: state.rightPanels,
			}),
		},
	),
);

export const usePanelStore = createPanelStore();
