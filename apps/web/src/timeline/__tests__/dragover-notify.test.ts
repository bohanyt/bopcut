import { expect, test } from "bun:test";
import { DragDropController, type DragDropConfig } from "@/timeline/controllers/drag-drop-controller";
import { TimelineDragSource } from "@/timeline/drag-source";
import { fixture, getHost, t, video } from "./compound-fixtures";

function setup() {
	const scenes = fixture();
	const tracks = getHost(scenes).tracks;
	tracks.main.elements = [video("existing", 0, 2)];
	tracks.overlay = [];
	tracks.audio = [];
	const rect = { left: 0, top: 0, width: 1200, height: 400, right: 1200, bottom: 400 };
	const dragSource = new TimelineDragSource();
	const dataTransfer = { types: [], setData() {} } as unknown as DataTransfer;
	dragSource.begin({
		dataTransfer,
		dragData: { id: "m1", name: "clip", type: "media", mediaType: "video" },
	});
	const config: DragDropConfig = {
		dragSource,
		zoomLevel: 1,
		getContainerEl: () => ({ getBoundingClientRect: () => rect }) as HTMLDivElement,
		getHeaderEl: () => null,
		getTracksScrollEl: () => ({ scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => rect }) as HTMLDivElement,
		getActiveProjectFps: () => ({ numerator: 30, denominator: 1 }),
		startMediaImport: () => null,
		getSceneId: () => "main",
		getSceneTracks: () => tracks,
		getCurrentPlayheadTime: () => t(0),
		getMediaAssets: () => [{ id: "m1", name: "clip", type: "video", duration: 2 } as never],
		importMediaFile: async () => null,
		executeCommand: () => undefined,
		insertElement: () => undefined,
		addClipEffect: () => {},
	};
	const controller = new DragDropController({ configRef: { current: config } });
	const at = (clientX: number, clientY = 20) =>
		({ clientX, clientY, preventDefault() {}, dataTransfer }) as unknown as React.DragEvent;
	let notifies = 0;
	controller.subscribe(() => {
		notifies += 1;
	});
	return { controller, at, notifies: () => notifies };
}

test("a pointer resting over the timeline during a drag re-renders it once, a move re-renders it again", () => {
	const { controller, at, notifies } = setup();
	for (let tick = 0; tick < 20; tick++) controller.onDragOver(at(400));
	expect(notifies()).toBe(1);

	controller.onDragOver(at(600));
	expect(notifies()).toBe(2);
	controller.onDragOver(at(600));
	expect(notifies()).toBe(2);
});
