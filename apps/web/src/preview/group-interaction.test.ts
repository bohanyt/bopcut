import { describe, expect, test } from "bun:test";
import { PreviewInteractionController } from "./controllers/preview-interaction-controller";
import { TransformHandleController } from "./controllers/transform-handle-controller";
import { PreviewPan, PreviewPointerCapture } from "./pointer-capture";

function fixture() {
	const el = (id: string, x: number) => ({
		id,
		type: "graphic",
		groupId: "g",
		hidden: false,
		startTime: 0,
		duration: 100,
		params: {
			"transform.positionX": x,
			"transform.positionY": 0,
			"transform.scaleX": 0.1,
			"transform.scaleY": 0.1,
			"transform.rotate": 0,
		},
	});
	const a = el("a", -100),
		b = el("b", 100),
		track = { id: "t", type: "graphic", hidden: false, elements: [a, b] };
	const tracks = {
		overlay: [track],
		main: { id: "m", type: "video", elements: [] },
		audio: [],
	};
	let selected: any[] = [],
		updates: any[] = [],
		commits = 0;
	let cancelGesture: (() => void) | undefined;
	const viewport = {
		pointerCapture: new PreviewPointerCapture(),
		screenToCanvas: ({ clientX, clientY }: any) => ({ x: clientX, y: clientY }),
		screenPixelsToLogicalThreshold: () => ({ x: 0, y: 0 }),
	};
	const scene = {
		getTracks: () => tracks,
		getCurrentTime: () => 0,
		getMediaAssets: () => [],
		getCanvasSize: () => ({ width: 1000, height: 1000 }),
		getSelectedElements: () => selected,
	};
	const timeline = {
		getElementsWithTracks: ({ elements }: any) =>
			elements.map((ref: any) => ({
				track: tracks.overlay.find(({ id }) => id === ref.trackId),
				element: [a, b].find((e) => e.id === ref.elementId),
			})),
		previewElements: (v: any[]) => {
			updates = v;
		},
		commitPreview: () => {
			commits++;
		},
		beginPreviewGesture: (onCancel: () => void) => {
			cancelGesture?.();
			const finish = () => {
				if (cancelGesture === cancel) cancelGesture = undefined;
			};
			const cancel = () => {
				finish();
				onCancel();
			};
			cancelGesture = cancel;
			return { cancel, finish };
		},
	};
	const selection = {
		getSelected: () => selected,
		setSelected: (v: any[]) => {
			selected = v;
		},
		clearSelection: () => {
			selected = [];
		},
	};
	const captured = new Set<number>();
	const view = new EventTarget();
	const ownerDocument = Object.assign(new EventTarget(), { activeElement: null, defaultView: view });
	const target = {
		ownerDocument,
		setPointerCapture: (pointerId: number) => { captured.add(pointerId); },
		hasPointerCapture: (pointerId: number) => captured.has(pointerId),
		releasePointerCapture: (pointerId: number) => { captured.delete(pointerId); },
	};
	const event = (x: number, y: number, pointerId = 1, type = "pointerup") =>
		({
			clientX: x,
			clientY: y,
			currentTarget: target,
			pointerId,
			button: 0,
			type,
			stopPropagation() {},
		}) as any;
	return {
		tracks,
		view,
		viewport,
		scene,
		timeline,
		selection,
		event,
		captured,
		captureTarget: target as unknown as Element,
		loseCapture(pointerId: number) {
			captured.delete(pointerId);
			ownerDocument.dispatchEvent(Object.assign(new Event("lostpointercapture"), { pointerId }));
		},
		updates: () => updates,
		commits: () => commits,
	};
}

function createCanvasController(f: ReturnType<typeof fixture>) {
	return new PreviewInteractionController({
		depsRef: {
			current: {
				...f,
				input: { isShiftHeld: () => true },
				playback: { getIsPlaying: () => false, subscribe: () => () => {} },
				preview: { isMaskMode: () => false },
			} as any,
		},
	});
}

function createTransformController(f: ReturnType<typeof fixture>) {
	return new TransformHandleController({
		depsRef: {
			current: {
				...f,
				input: { isShiftHeld: () => true },
				preview: {},
			} as any,
		},
	});
}

describe("preview canvas pointer ownership", () => {
	test("detaching a transform handle retires pending capture without a browser event", () => {
		const f = fixture();
		const canvas = createCanvasController(f);
		const handle = createTransformController(f);
		f.selection.setSelected([{ trackId: "t", elementId: "a" }]);
		try {
			handle.onCornerPointerDown({ event: f.event(450, 550, 2), corner: "bottom-right" });
			expect(handle.activeHandle).toBe("bottom-right");
			f.viewport.pointerCapture.cancelCaptureOn({} as Element);
			expect(handle.activeHandle).toBe("bottom-right");
			f.captured.delete(2);
			f.viewport.pointerCapture.cancelCaptureOn(f.captureTarget);
			expect(handle.activeHandle).toBeNull();
			handle.onPointerUp(f.event(450, 550, 2));
			expect(f.commits()).toBe(0);
			canvas.onPointerDown(f.event(400, 500));
			expect(f.captured).toEqual(new Set([1]));
		} finally {
			canvas.destroy();
			handle.destroy();
		}
	});

	test("document-level loss cancels the transform after its captured handle disappears", () => {
		const f = fixture();
		const canvas = createCanvasController(f);
		const handle = createTransformController(f);
		f.selection.setSelected([{ trackId: "t", elementId: "a" }]);
		try {
			handle.onCornerPointerDown({ event: f.event(450, 550, 2), corner: "bottom-right" });
			expect(handle.activeHandle).toBe("bottom-right");
			f.loseCapture(3);
			expect(handle.activeHandle).toBe("bottom-right");
			f.loseCapture(2);
			expect(handle.activeHandle).toBeNull();
			expect(f.commits()).toBe(0);
			canvas.onPointerDown(f.event(400, 500));
			expect(f.captured).toEqual(new Set([1]));
		} finally {
			canvas.destroy();
			handle.destroy();
		}
	});

	test("document-level loss ends a pan if the viewport is removed", () => {
		const f = fixture();
		const pan = new PreviewPan(f.viewport.pointerCapture);
		const canvas = createCanvasController(f);
		try {
			let ended = false;
			expect(pan.start(f.event(530, 500, 2), { x: 500, y: 500 }, () => { ended = true; })).toBe(true);
			f.loseCapture(2);
			expect(ended).toBe(true);
			expect(pan.move(f.event(550, 510, 2), 1)).toBeNull();
			canvas.onPointerDown(f.event(400, 500));
			expect(f.captured).toEqual(new Set([1]));
		} finally {
			pan.finish();
			canvas.destroy();
		}
	});

	test("pan cannot start during a clip drag or consume events from another pointer", () => {
		const f = fixture();
		const canvas = createCanvasController(f);
		const pan = new PreviewPan(f.viewport.pointerCapture);
		const center = { x: 500, y: 500 };
		const onLostCapture = () => {};
		try {
			canvas.onPointerDown(f.event(400, 500));
			canvas.onPointerMove(f.event(430, 520));
			expect(pan.start(f.event(530, 500, 2), center, onLostCapture)).toBe(false);
			canvas.onPointerUp(f.event(430, 520));
			expect(f.commits()).toBe(1);

			expect(pan.start(f.event(530, 500, 2), center, onLostCapture)).toBe(true);
			expect(pan.start(f.event(540, 500, 3), center, onLostCapture)).toBe(false);
			expect(pan.move(f.event(450, 520), 1)).toBeNull();
			expect(pan.finish(f.event(450, 520))).toBe(false);
			canvas.onPointerDown(f.event(400, 500));
			expect(f.captured).toEqual(new Set([2]));
			expect(pan.move(f.event(550, 510, 2), 1)).toEqual({ x: 480, y: 490 });

			f.captured.delete(2);
			expect(pan.finish(f.event(550, 510, 2, "lostpointercapture"))).toBe(true);
			canvas.onPointerDown(f.event(400, 500));
			expect(f.captured).toEqual(new Set([1]));
		} finally {
			pan.finish();
			canvas.destroy();
		}
	});

	test("a clip drag and transform handle cannot steal each other's capture", () => {
		const f = fixture();
		const canvas = createCanvasController(f);
		const handle = createTransformController(f);
		try {
			canvas.onPointerDown(f.event(400, 500));
			canvas.onPointerMove(f.event(430, 520));
			const preview = f.updates();
			handle.onCornerPointerDown({ event: f.event(650, 550, 2), corner: "bottom-right" });
			handle.onPointerMove({ event: f.event(800, 600, 2) });
			expect(f.captured).toEqual(new Set([1]));
			expect(f.updates()).toBe(preview);
			canvas.onPointerUp(f.event(430, 520));
			expect(f.commits()).toBe(1);

			handle.onCornerPointerDown({ event: f.event(650, 550, 2), corner: "bottom-right" });
			canvas.onPointerDown(f.event(400, 500));
			expect(f.captured).toEqual(new Set([2]));
			handle.onPointerUp(f.event(650, 550, 2, "lostpointercapture"));
			canvas.onPointerDown(f.event(400, 500));
			expect(f.captured).toEqual(new Set([1]));
		} finally {
			canvas.destroy();
			handle.destroy();
		}
	});

	test("a second pointer cannot start, move or finish the captured drag", () => {
		const f = fixture();
		const controller = createCanvasController(f);
		controller.onPointerDown(f.event(400, 500));
		controller.onPointerDown(f.event(600, 500, 2));
		controller.onPointerMove(f.event(640, 520, 2));
		expect(f.captured).toEqual(new Set([1]));
		expect(f.updates()).toEqual([]);

		controller.onPointerMove(f.event(430, 520));
		const preview = f.updates();
		expect(preview).toHaveLength(2);
		controller.onPointerMove(f.event(650, 550, 2));
		for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
			controller.onPointerUp(f.event(650, 550, 2, type));
		}
		expect(f.updates()).toBe(preview);
		expect(f.captured).toEqual(new Set([1]));
		expect(f.commits()).toBe(0);

		controller.onPointerUp(f.event(430, 520));
		expect(f.captured.size).toBe(0);
		expect(f.commits()).toBe(1);
		controller.destroy();
	});

	for (const type of ["pointercancel", "lostpointercapture"]) {
		test(`${type} retires a canvas drag and allows another pointer to start`, () => {
			const f = fixture();
			const controller = createCanvasController(f);
			controller.onPointerDown(f.event(400, 500));
			controller.onPointerMove(f.event(430, 520));
			expect(f.updates()).toHaveLength(2);
			if (type === "lostpointercapture") f.captured.delete(1);
			controller.onPointerUp(f.event(430, 520, 1, type));

			const preview = f.updates();
			controller.onPointerMove(f.event(450, 530));
			controller.onPointerUp(f.event(450, 530));
			expect(f.updates()).toBe(preview);
			expect(f.captured.size).toBe(0);
			expect(f.commits()).toBe(0);

			controller.onPointerDown(f.event(400, 500, 2));
			controller.onPointerMove(f.event(430, 520, 2));
			controller.onPointerUp(f.event(430, 520, 2));
			expect(f.commits()).toBe(1);
			controller.destroy();
		});
	}
});

describe("preview groups", () => {
	test.each(["clip", "track"] as const)("canvas gestures skip a selected hidden %s", (hidden) => {
		const f = fixture();
		const [a, b] = f.tracks.overlay[0].elements;
		if (hidden === "clip") b.hidden = true;
		else {
			f.tracks.overlay[0].elements = [a];
			f.tracks.overlay.push({ id: "hidden", type: "graphic", hidden: true, elements: [b] });
		}
		f.selection.setSelected([
			{ trackId: "t", elementId: "a" },
			{ trackId: hidden === "track" ? "hidden" : "t", elementId: "b" },
		]);
		const body = createCanvasController(f);
		const handles = createTransformController(f);
		try {
			body.onPointerDown(f.event(400, 500));
			body.onPointerMove(f.event(430, 520));
			body.onPointerUp(f.event(430, 520));
			expect(f.updates().map((update) => update.elementId)).toEqual(["a"]);
			handles.onCornerPointerDown({ event: f.event(450, 550), corner: "bottom-right" });
			handles.onPointerMove({ event: f.event(500, 600) });
			handles.onPointerUp(f.event(500, 600));
			expect(f.updates().map((update) => update.elementId)).toEqual(["a"]);
		} finally {
			body.destroy();
			handles.destroy();
		}
	});

	test("window blur cancels captured canvas moves and transform handles", () => {
		const f = fixture();
		f.selection.setSelected([{ trackId: "t", elementId: "a" }]);
		const body = createCanvasController(f);
		const handles = createTransformController(f);
		try {
			body.onPointerDown(f.event(400, 500));
			body.onPointerMove(f.event(430, 520));
			f.view.dispatchEvent(new Event("blur"));
			body.onPointerUp(f.event(430, 520));
			expect(f.captured.size).toBe(0);
			expect(f.commits()).toBe(0);
			handles.onCornerPointerDown({ event: f.event(450, 550), corner: "bottom-right" });
			handles.onPointerMove({ event: f.event(500, 600) });
			f.view.dispatchEvent(new Event("blur"));
			handles.onPointerUp(f.event(500, 600));
			expect(handles.activeHandle).toBeNull();
			expect(f.captured.size).toBe(0);
			expect(f.commits()).toBe(0);
		} finally {
			body.destroy();
			handles.destroy();
		}
	});
	test("selects and moves members together, double-click isolates one", () => {
		const f = fixture();
		const c = createCanvasController(f);
		c.onPointerDown(f.event(400, 500));
		c.onPointerUp(f.event(400, 500));
		expect(f.selection.getSelected().map((r) => r.elementId)).toEqual([
			"a",
			"b",
		]);
		c.onPointerDown(f.event(400, 500));
		c.onPointerMove(f.event(430, 520));
		c.onPointerUp(f.event(430, 520));
		expect(
			f.updates().map((u) => u.updates.params["transform.positionX"]),
		).toEqual([-70, 130]);
		expect(f.commits()).toBe(1);
		c.onDoubleClick(f.event(600, 500));
		expect(f.selection.getSelected().map((r) => r.elementId)).toEqual(["b"]);
		c.destroy();
	});
	test("scales and rotates all members around shared bounds", () => {
		const f = fixture();
		f.selection.setSelected([
			{ trackId: "t", elementId: "a" },
			{ trackId: "t", elementId: "b" },
		]);
		const c = createTransformController(f);
		c.onCornerPointerDown({ event: f.event(650, 550), corner: "bottom-right" });
		c.onPointerMove({ event: f.event(800, 600) });
		expect(
			f.updates().map((u) => u.updates.params["transform.positionX"]),
		).toEqual([-200, 200]);
		expect(
			f.updates().map((u) => u.updates.params["transform.scaleX"]),
		).toEqual([0.2, 0.2]);
		c.onPointerUp(f.event(800, 600));
		expect(f.commits()).toBe(1);
		c.onRotationPointerDown({ event: f.event(500, 400) });
		c.onPointerMove({ event: f.event(600, 500) });
		expect(
			f.updates().map((u) => Math.round(u.updates.params["transform.rotate"])),
		).toEqual([90, 90]);
		c.onPointerUp(f.event(600, 500));
		c.destroy();
	});
});
