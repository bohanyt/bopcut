import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ParamValues } from "@/params";
import { model3dState } from "./state";
import { GraphicsDeviceError } from "@/services/renderer/device-lifecycle";

const models = new Map<string, { file: File; promise: Promise<THREE.Group> }>();
let renderer: THREE.WebGLRenderer | undefined;
let contextLost = false;
const restoredListeners = new Set<() => void>();

export class ModelGraphicsError extends GraphicsDeviceError {}

export function onModelGraphicsRestored(listener: () => void): () => void {
	restoredListeners.add(listener);
	return () => { restoredListeners.delete(listener); };
}

export function retryModelGraphics(): void {
	if (!contextLost) return;
	renderer?.dispose();
	renderer = undefined;
	contextLost = false;
	for (const listener of restoredListeners) listener();
}

function checkModelContext(renderer?: THREE.WebGLRenderer) {
	contextLost ||= renderer?.getContext().isContextLost() === true;
	if (contextLost) {
		throw new ModelGraphicsError("The 3D model graphics context was lost. Try again after it is restored.");
	}
}

async function loadModel(id: string, file: File): Promise<THREE.Group> {
	const cached = models.get(id);
	if (cached?.file === file) return cached.promise;
	const promise = (async () => {
		const data = await file.arrayBuffer();
		// glTF with external resources cannot be read from a single imported file.
		if (/\.gltf$/i.test(file.name)) {
			const json = JSON.parse(new TextDecoder().decode(data));
			for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
				if (resource.uri && !resource.uri.startsWith("data:")) throw new Error("glTF resources must be embedded; use GLB or a self-contained glTF");
			}
		}
		const gltf = await new GLTFLoader().parseAsync(data, "");
		const box = new THREE.Box3().setFromObject(gltf.scene);
		const size = box.getSize(new THREE.Vector3());
		const center = box.getCenter(new THREE.Vector3());
		const extent = Math.max(size.x, size.y, size.z);
		if (!Number.isFinite(extent) || extent <= 0) throw new Error("Model has no visible geometry");
		const normalized = new THREE.Group();
		gltf.scene.position.sub(center);
		normalized.add(gltf.scene);
		normalized.scale.setScalar(2 / extent);
		const pivot = new THREE.Group();
		pivot.add(normalized);
		return pivot;
	})();
	models.set(id, { file, promise });
	promise.catch(() => { if (models.get(id)?.promise === promise) models.delete(id); });
	return promise;
}

export async function renderModel3d({ id, file, params, size, signal }: { id: string; file: File; params: ParamValues; size: number; signal?: AbortSignal }): Promise<OffscreenCanvas> {
	signal?.throwIfAborted();
	checkModelContext(renderer);
	const model = await loadModel(id, file);
	signal?.throwIfAborted();
	const state = model3dState(params);
	if (!renderer) {
		try {
			renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
		} catch (error) {
			contextLost = true;
			throw new ModelGraphicsError("The 3D model graphics context could not start. Retry 3D graphics.", { cause: error });
		}
		renderer.setPixelRatio(1);
		renderer.setClearColor(0x000000, 0);
		// Three.js registers its own loss and restoration handlers during construction.
		// Its restoration handler rebuilds GL resources before this listener runs.
		const current = renderer;
		renderer.domElement.addEventListener("webglcontextlost", () => {
			if (renderer === current) contextLost = true;
		});
		renderer.domElement.addEventListener("webglcontextrestored", () => {
			if (renderer !== current) return;
			contextLost = false;
			for (const listener of restoredListeners) listener();
		});
	}
	checkModelContext(renderer);
	renderer.setSize(size, size, false);
	const scene = new THREE.Scene();
	model.rotation.set(...state.rotation);
	model.scale.setScalar(state.scale);
	scene.add(model);
	const camera = new THREE.PerspectiveCamera(state.fov, 1, 0.01, 1000);
	camera.position.set(0, 0, state.distance);
	camera.lookAt(0, 0, 0);
	scene.add(new THREE.AmbientLight(0xffffff, 0.5));
	const light = new THREE.DirectionalLight(0xffffff, state.intensity);
	light.position.set(...state.light);
	scene.add(light);
	try {
		renderer.render(scene, camera);
		checkModelContext(renderer);
		const canvas = new OffscreenCanvas(size, size);
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Could not create model canvas");
		ctx.drawImage(renderer.domElement, 0, 0);
		checkModelContext(renderer);
		return canvas;
	} finally {
		scene.remove(model);
	}
}
