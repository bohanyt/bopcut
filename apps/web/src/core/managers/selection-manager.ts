import type { EditorCore } from "@/core";
import type { SelectedKeyframeRef } from "@/animation/types";
import type {
	EditorSelectionKind,
	EditorSelectionPatch,
	EditorSelectionSnapshot,
	SelectedMaskPointSelection,
} from "@/selection/editor-selection";
import type { ElementRef } from "@/timeline/types";

/** Same refs in the same order, compared by value. */
function sameRefs<T extends object>(a: readonly T[], b: readonly T[]): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	return a.every((ref, index) => {
		const other = b[index] as Record<string, unknown>;
		const entries = Object.entries(ref);
		return entries.length === Object.keys(other).length && entries.every(([key, value]) => other[key] === value);
	});
}

export class SelectionManager {
	private selectedElements: ElementRef[] = [];
	private selectedKeyframes: SelectedKeyframeRef[] = [];
	private keyframeSelectionAnchor: SelectedKeyframeRef | null = null;
	private selectedMaskPoints: SelectedMaskPointSelection | null = null;
	private listeners = new Set<() => void>();

	constructor(editor: EditorCore) {
		void editor;
	}

	getSelectedElements(): ElementRef[] {
		return this.selectedElements;
	}

	getSelectedKeyframes(): SelectedKeyframeRef[] {
		return this.selectedKeyframes;
	}

	getKeyframeSelectionAnchor(): SelectedKeyframeRef | null {
		return this.keyframeSelectionAnchor;
	}

	getSelectedMaskPointSelection(): SelectedMaskPointSelection | null {
		return this.selectedMaskPoints;
	}

	getActiveSelectionKind(): EditorSelectionKind | null {
		if ((this.selectedMaskPoints?.pointIds.length ?? 0) > 0) {
			return "mask-points";
		}
		if (this.selectedKeyframes.length > 0) {
			return "keyframes";
		}
		if (this.selectedElements.length > 0) {
			return "elements";
		}
		return null;
	}

	getSnapshot(): EditorSelectionSnapshot {
		return {
			selectedElements: [...this.selectedElements],
			selectedKeyframes: [...this.selectedKeyframes],
			keyframeSelectionAnchor: this.keyframeSelectionAnchor,
			selectedMaskPoints: this.selectedMaskPoints
				? {
						...this.selectedMaskPoints,
						pointIds: [...this.selectedMaskPoints.pointIds],
					}
				: null,
		};
	}

	setSelectedElements({ elements }: { elements: ElementRef[] }): void {
		// A box drag sets the selection on every move: an unchanged one wakes no listener.
		if (
			sameRefs(this.selectedElements, elements) && this.selectedKeyframes.length === 0 &&
			this.keyframeSelectionAnchor === null && this.selectedMaskPoints === null
		) {
			return;
		}
		this.selectedElements = elements;
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.selectedMaskPoints = null;
		this.notify();
	}

	setSelectedKeyframes({
		keyframes,
		anchorKeyframe,
	}: {
		keyframes: SelectedKeyframeRef[];
		anchorKeyframe?: SelectedKeyframeRef | null;
	}): void {
		const anchor = anchorKeyframe !== undefined
			? anchorKeyframe
			: keyframes.length === 0 ? null : this.keyframeSelectionAnchor;
		const sameAnchor = anchor === this.keyframeSelectionAnchor ||
			(anchor !== null && this.keyframeSelectionAnchor !== null && sameRefs([anchor], [this.keyframeSelectionAnchor]));
		if (sameRefs(this.selectedKeyframes, keyframes) && sameAnchor && this.selectedMaskPoints === null) return;
		this.selectedKeyframes = keyframes;
		if (anchorKeyframe !== undefined) {
			this.keyframeSelectionAnchor = anchorKeyframe;
		} else if (keyframes.length === 0) {
			this.keyframeSelectionAnchor = null;
		}
		this.selectedMaskPoints = null;
		this.notify();
	}

	setSelectedMaskPoints({
		selection,
	}: {
		selection: SelectedMaskPointSelection | null;
	}): void {
		this.selectedMaskPoints =
			selection && selection.pointIds.length > 0
				? {
						...selection,
						pointIds: [...selection.pointIds],
					}
				: null;
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.notify();
	}

	clearSelection(): void {
		this.selectedElements = [];
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.selectedMaskPoints = null;
		this.notify();
	}

	clearKeyframeSelection(): void {
		this.selectedKeyframes = [];
		this.keyframeSelectionAnchor = null;
		this.notify();
	}

	clearMaskPointSelection(): void {
		if (!this.selectedMaskPoints) {
			return;
		}
		this.selectedMaskPoints = null;
		this.notify();
	}

	clearMostSpecificSelection(): boolean {
		const activeSelectionKind = this.getActiveSelectionKind();
		if (activeSelectionKind === "mask-points") {
			this.clearMaskPointSelection();
			return true;
		}
		if (activeSelectionKind === "keyframes") {
			this.clearKeyframeSelection();
			return true;
		}
		if (activeSelectionKind === "elements") {
			this.setSelectedElements({ elements: [] });
			return true;
		}
		return false;
	}

	applySelectionPatch({
		patch,
	}: {
		patch: EditorSelectionPatch;
	}): EditorSelectionSnapshot {
		if (patch.selectedElements !== undefined) {
			this.selectedElements = [...patch.selectedElements];
		}
		if (patch.selectedKeyframes !== undefined) {
			this.selectedKeyframes = [...patch.selectedKeyframes];
		}
		if (patch.keyframeSelectionAnchor !== undefined) {
			this.keyframeSelectionAnchor = patch.keyframeSelectionAnchor;
		}
		if (patch.selectedMaskPoints !== undefined) {
			this.selectedMaskPoints = patch.selectedMaskPoints
				? {
						...patch.selectedMaskPoints,
						pointIds: [...patch.selectedMaskPoints.pointIds],
					}
				: null;
		}
		this.notify();
		return this.getSnapshot();
	}

	restoreSnapshot({ snapshot }: { snapshot: EditorSelectionSnapshot }): void {
		this.selectedElements = [...snapshot.selectedElements];
		this.selectedKeyframes = [...snapshot.selectedKeyframes];
		this.keyframeSelectionAnchor = snapshot.keyframeSelectionAnchor;
		this.selectedMaskPoints = snapshot.selectedMaskPoints
			? {
					...snapshot.selectedMaskPoints,
					pointIds: [...snapshot.selectedMaskPoints.pointIds],
				}
			: null;
		this.notify();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
