import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { TimelineTrack } from "@/timeline";
import { video } from "@/timeline/__tests__/compound-fixtures";
import { useTimelineKeyboard } from "./timeline-keyboard";

const moving = video("source-clip", 1, 2);
const distant = video("distant-clip", 250, 2);
const anchor = video("anchor", 0, 1);

function track(id: string, elements: (typeof moving)[]): TimelineTrack {
	return { id, name: id, type: "video", muted: false, hidden: false, elements };
}

function Rows({ tracks }: { tracks: TimelineTrack[] }) {
	const { bindings } = useTimelineKeyboard(tracks, () => []);
	return (
		<div {...bindings}>
			{tracks.map((row) => (
				<div key={row.id} data-timeline-track-id={row.id}>
					<button data-timeline-track-button>{row.name}</button>
					{row.elements.map((clip) => (
						<div key={clip.id} data-timeline-element-id={clip.id}>
							<button>{clip.name}</button>
						</div>
					))}
				</div>
			))}
		</div>
	);
}

test("delete, cross-track drop, undo, and redo do not focus or scroll timeline controls", async () => {
	const dom = new Window();
	const globals = {
		window: dom,
		document: dom.document,
		HTMLElement: dom.HTMLElement,
		HTMLButtonElement: dom.HTMLButtonElement,
		IS_REACT_ACT_ENVIRONMENT: true,
		CSS: dom.CSS,
	};
	const originals = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const focus = spyOn(dom.HTMLElement.prototype, "focus");
	const scroll = spyOn(dom.HTMLElement.prototype, "scrollIntoView");
	try {
		const before = [
			track("main", [moving, distant]),
			track("overlay", [anchor]),
		];
		const deleted = [track("main", [distant]), before[1]];
		const moved = [deleted[0], track("overlay", [anchor, moving])];
		const render = (tracks: TimelineTrack[]) =>
			act(() => root.render(<Rows tracks={tracks} />));
		for (const after of [deleted, moved]) {
			render(before);
			const button = container.querySelector<HTMLButtonElement>(
				'[data-timeline-element-id="source-clip"] button',
			)!;
			act(() => button.focus());
			expect(document.activeElement).toBe(button);
			focus.mockClear();
			scroll.mockClear();

			// A blank click may leave no focused control before the edit commits.
			act(() => button.blur());
			render(after);
			render(before); // Undo
			render(after); // Redo
			expect(focus).not.toHaveBeenCalled();
			expect(scroll).not.toHaveBeenCalled();
		}
	} finally {
		act(() => root.unmount());
		focus.mockRestore();
		scroll.mockRestore();
		await dom.close();
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});
