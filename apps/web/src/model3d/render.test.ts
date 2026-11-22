import { expect, spyOn, test } from "bun:test";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Texture } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ModelGraphicsError, modelGraphics, renderModel3d, retryModelGraphics } from "./render";

test("a render outside preview exposes Retry and retires cached model resources", async () => {
	const scene = new Group();
	const geometry = new BoxGeometry();
	const texture = new Texture();
	const material = new MeshBasicMaterial({ map: texture });
	scene.add(new Mesh(geometry, material));
	const geometryDispose = spyOn(geometry, "dispose");
	const materialDispose = spyOn(material, "dispose");
	const textureDispose = spyOn(texture, "dispose");
	const parse = spyOn(GLTFLoader.prototype, "parseAsync").mockResolvedValue({ scene } as GLTF);
	const states: boolean[] = [];
	const unsubscribe = modelGraphics.subscribe(() => states.push(modelGraphics.getSnapshot()));
	try {
		const file = new File(["model"], "model.glb");
		await expect(renderModel3d({ id: "retry-test", file, params: {}, size: 16 })).rejects.toBeInstanceOf(ModelGraphicsError);
		expect(modelGraphics.getSnapshot()).toBe(true);
		retryModelGraphics();
		await Promise.resolve();
		expect(states).toEqual([true, false]);
		expect(geometryDispose).toHaveBeenCalledTimes(1);
		expect(materialDispose).toHaveBeenCalledTimes(1);
		expect(textureDispose).toHaveBeenCalledTimes(1);
	} finally {
		unsubscribe();
		retryModelGraphics();
		parse.mockRestore();
	}
});

test("a model still loading at Retry cannot draw into the replacement renderer", async () => {
	const pending = Promise.withResolvers<GLTF>();
	const scene = new Group();
	const geometry = new BoxGeometry();
	scene.add(new Mesh(geometry, new MeshBasicMaterial()));
	const dispose = spyOn(geometry, "dispose");
	const loadStarted = Promise.withResolvers<void>();
	const parse = spyOn(GLTFLoader.prototype, "parseAsync")
		.mockImplementationOnce(() => {
			loadStarted.resolve();
			return pending.promise;
		})
		.mockResolvedValue({ scene: scene.clone() } as GLTF);
	const file = new File(["model"], "model.glb");
	const loading = renderModel3d({ id: "late-model", file, params: {}, size: 16 });
	try {
		await loadStarted.promise;
		await expect(renderModel3d({ id: "other-model", file, params: {}, size: 16 })).rejects.toBeInstanceOf(ModelGraphicsError);
		retryModelGraphics();
		dispose.mockClear();
		pending.resolve({ scene } as GLTF);
		await expect(loading).rejects.toThrow("3D graphics changed during rendering");
		expect(modelGraphics.getSnapshot()).toBe(false);
		expect(dispose).toHaveBeenCalledTimes(1);
	} finally {
		pending.resolve({ scene } as GLTF);
		await loading.catch(() => {});
		retryModelGraphics();
		parse.mockRestore();
	}
});
