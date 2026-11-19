import { describe, expect, mock, test } from "bun:test";
import type { VideoElement } from "@/timeline";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { buildBundleScenes } = await import("./importer");

const clip = (agent_id: string, extra: Record<string, unknown> = {}) => ({ agent_id, name: agent_id, start: 0, duration: 2, asset: "clip", ...extra });

describe("a video's own sound", () => {
	test("is off unless the element asks for it with sourceAudio", () => {
		const { tracks } = buildBundleScenes({
			bundle: { name: "t", width: 1920, height: 1080, assets: [], audio: [], overlay: [], main: [clip("quiet"), { ...clip("loud", { sourceAudio: true }), start: 2 }] },
			media: new Map([["clip", { id: "m", type: "video", width: 1920, height: 1080, duration: 10 }]]),
			sceneId: "main",
		});
		const [quiet, loud] = tracks.main.elements as VideoElement[];
		expect(quiet.isSourceAudioEnabled).toBe(false);
		expect(loud.isSourceAudioEnabled).toBe(true);
	});
});
