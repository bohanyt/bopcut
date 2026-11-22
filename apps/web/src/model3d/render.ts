import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ParamValues } from "@/params";
import { model3dState } from "./state";
import { GraphicsDeviceError } from "@/services/renderer/device-lifecycle";

type CachedModel = { file: File; promise: Promise<THREE.Group>; model?: THREE.Group };
const models = new Map<string, CachedModel>();
let renderer: THREE.WebGLRenderer | undefined;
let contextLost = false;
let generation = 0;
const graphicsListeners = new Set<() => void>();

export class ModelGraphicsError extends GraphicsDeviceError {
	constructor(message: string, options?: ErrorOptions) {
		super("graphicsModel", message, options);
	}
}

export const modelGraphics = {
	getSnapshot: () => contextLost,
	subscribe(listener: () => void) {
		graphicsListeners.add(listener);
		return () => { graphicsListeners.delete(listener); };
	},
};

function setContextLost(lost: boolean) {
	if (contextLost === lost) return;
	contextLost = lost;
	if (lost) generation++;
	for (const listener of graphicsListeners) listener();
}

function disposeModel(model: THREE.Group): void {
	const geometries = new Set<THREE.BufferGeometry>();
	const materials = new Set<THREE.Material>();
	const skeletons = new Set<THREE.Skeleton>();
	const textures = new Set<THREE.Texture>();
	const images = new Set<ImageBitmap>();
	model.traverse((object) => {
		if (object instanceof THREE.SkinnedMesh) skeletons.add(object.skeleton);
		if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points)) return;
		geometries.add(object.geometry);
		for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
			materials.add(material);
		}
	});
	for (const geometry of geometries) geometry.dispose();
	for (const skeleton of skeletons) skeleton.dispose();
	for (const material of materials) {
		for (const value of Object.values(material)) {
			if (value instanceof THREE.Texture) textures.add(value);
		}
		material.dispose();
	}
	for (const texture of textures) {
		if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) images.add(texture.image);
		texture.dispose();
	}
	for (const image of images) image.close();
}

function retireModels() {
	for (const entry of models.values()) {
		if (entry.model) disposeModel(entry.model);
		else void entry.promise.then(disposeModel, () => {});
	}
	models.clear();
}

export function retryModelGraphics(): void {
	if (!contextLost) return;
	retireModels();
	renderer?.dispose();
	renderer = undefined;
	setContextLost(false);
}

function checkModelContext(renderer?: THREE.WebGLRenderer) {
	if (renderer?.getContext().isContextLost()) setContextLost(true);
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
	const entry: CachedModel = { file, promise };
	models.set(id, entry);
	void promise.then(
		(model) => { entry.model = model; },
		() => { if (models.get(id) === entry) models.delete(id); },
	);
	return promise;
}

export async function renderModel3d({ id, file, params, size, signal }: { id: string; file: File; params: ParamValues; size: number; signal?: AbortSignal }): Promise<OffscreenCanvas> {
	signal?.throwIfAborted();
	checkModelContext(renderer);
	const startedIn = generation;
	const model = await loadModel(id, file);
	signal?.throwIfAborted();
	if (generation !== startedIn) throw new ModelGraphicsError("3D graphics changed during rendering. Try again.");
	const state = model3dState(params);
	if (!renderer) {
		try {
			renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
		} catch (error) {
			setContextLost(true);
			throw new ModelGraphicsError("The 3D model graphics context could not start. Retry 3D graphics.", { cause: error });
		}
		renderer.setPixelRatio(1);
		renderer.setClearColor(0x000000, 0);
		// Three.js registers its own loss and restoration handlers during construction.
		// Its restoration handler rebuilds GL resources before this listener runs.
		const current = renderer;
		renderer.domElement.addEventListener("webglcontextlost", () => {
			if (renderer === current) setContextLost(true);
		});
		renderer.domElement.addEventListener("webglcontextrestored", () => {
			if (renderer !== current) return;
			retireModels();
			setContextLost(false);
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
