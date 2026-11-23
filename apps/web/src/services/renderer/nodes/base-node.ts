export type BaseNodeParams = object | undefined;
export type AnyBaseNode = BaseNode<BaseNodeParams, unknown>;

export class BaseNode<
	Params extends BaseNodeParams = BaseNodeParams,
	Resolved = unknown,
> {
	readonly params: Readonly<Params>;
	resolved: Resolved | null = null;

	constructor(params?: Params, children: readonly AnyBaseNode[] = []) {
		this.params = params ?? ({} as Params);
		this.childNodes = [...children];
	}

	private childNodes: AnyBaseNode[];

	get children(): readonly AnyBaseNode[] {
		return this.childNodes;
	}

	add(child: AnyBaseNode) {
		this.childNodes.push(child);
		return this;
	}

	remove(child: AnyBaseNode) {
		this.childNodes = this.childNodes.filter((c) => c !== child);
		return this;
	}
}
