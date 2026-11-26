import { describe, expect, mock, test } from "bun:test";
import { checkAgentCaption, updateAgentCaption } from "@/agent/captions";
import type { AgentElement } from "@/agent/elements";
import { createTextPreset } from "@/text/presets";
import { resolveTextStyle } from "@/text/style";
import { buildTextElement } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import type { TextElement } from "@/timeline";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { computeAgentDraft } = await import("@/agent/draft");
const { buildDefaultScene } = await import("@/timeline/scenes");

const badHighlight: AgentElement = {
	agent_id: "cap-bad",
	name: "Caption",
	start: 0,
	duration: 3,
	caption: {
		text: "Hello world",
		highlight: { color: "not-a-color", scale: 10 },
	},
};

describe("agent caption highlight shorthand", () => {
	test("an invalid highlight color is refused before the draft is built", () => {
		expect(() => checkAgentCaption(badHighlight)).toThrow(/caption\.(activeColor|highlightColor)/);
		const scene = buildDefaultScene({ name: "Main", isMain: true });
		const result = computeAgentDraft({
			scenes: [scene],
			rootSceneId: scene.id,
			ops: [{ op: "add", track: { name: "Captions" }, element: badHighlight }],
			canvas: { width: 1280, height: 720 },
			mediaFor: () => undefined,
			fps: { numerator: 30, denominator: 1 },
			ripple: false,
		});
		expect(result.results[0].ok).toBe(false);
	});

	test("a highlight scale is kept to the 1-3 range, and what it stores can be saved as a preset", () => {
		const base = buildTextElement({
			raw: { name: "t", params: { content: "Hello" } },
			startTime: mediaTimeFromSeconds({ seconds: 0 }),
		}) as TextElement;
		const el = updateAgentCaption(base, { text: "Hello world", highlight: { color: "#ff0000", scale: 10 } });
		expect(el.params["caption.activeScale"]).toBe(3);
		expect(el.params["caption.activeColor"]).toBe("#ff0000");
		expect(resolveTextStyle(el, 60, 0).activeScale).toBe(3);
		expect(() => createTextPreset("Saved", el)).not.toThrow();
		// A saved element from before the check still renders at most 3×.
		expect(resolveTextStyle({ ...el, params: { ...el.params, "caption.activeScale": 10 } }, 60, 0).activeScale).toBe(3);
	});
});
