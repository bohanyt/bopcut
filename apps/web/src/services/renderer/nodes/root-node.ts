import { SceneVisibility, type SceneChild } from "../scene-visibility";
import { BaseNode, type AnyBaseNode } from "./base-node";

export type RootNodeParams = {
	duration: number;
};

export class RootNode extends BaseNode<RootNodeParams> {
	// Scene builds take a fresh snapshot of the timeline, including each compound's content.
	private visibility?: SceneVisibility;
	activeChildren: readonly SceneChild[] = [];

	constructor(params: RootNodeParams, children?: readonly AnyBaseNode[]) {
		super(params, children);
		if (children) this.visibility = new SceneVisibility(this.children);
	}

	get duration() {
		return this.params.duration ?? 0;
	}

	childrenAt(time: number): readonly SceneChild[] {
		this.visibility ??= new SceneVisibility(this.children);
		return this.visibility.at(time);
	}

	override add(child: AnyBaseNode) {
		this.visibility = undefined;
		return super.add(child);
	}

	override remove(child: AnyBaseNode) {
		this.visibility = undefined;
		return super.remove(child);
	}
}
