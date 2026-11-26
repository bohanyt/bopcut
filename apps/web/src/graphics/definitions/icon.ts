import type { GraphicDefinition } from "../types";

/** One SVG element, read once: its own styles and geometry, with fill and stroke as inherited from its parents. */
type IconNode = {
	fill: string; stroke: string; lineWidth: string | null; cap: CanvasLineCap | null; join: CanvasLineJoin | null;
	opacity: string | null; matrix: DOMMatrix | null; path: Path2D | null; evenOdd: boolean; children: IconNode[];
};
type ParsedIcon = { box: number[]; root: IconNode } | null;

/** Icons animate their size and color, which redraws them; the SVG text is parsed once, not for every frame. */
const PARSED_ICONS_KEPT = 32;
const parsedIcons = new Map<string, ParsedIcon>();

function readNode(node: Element, fill: string, stroke: string): IconNode {
	fill = node.getAttribute("fill") ?? fill;
	stroke = node.getAttribute("stroke") ?? stroke;
	const cap = node.getAttribute("stroke-linecap");
	const join = node.getAttribute("stroke-linejoin");
	const transform = node.getAttribute("transform");
	let matrix: DOMMatrix | null = null;
	if (transform) {
		try { matrix = new DOMMatrix(transform); } catch { /* Unsupported transform. */ }
	}
	const n = (key: string) => Number(node.getAttribute(key) ?? 0);
	let path: Path2D | null = new Path2D();
	try {
		switch (node.localName) {
			case "path": path.addPath(new Path2D(node.getAttribute("d") ?? "")); break;
			case "rect": path.roundRect(n("x"), n("y"), n("width"), n("height"), n("rx")); break;
			case "circle": path.arc(n("cx"), n("cy"), n("r"), 0, Math.PI * 2); break;
			case "ellipse": path.ellipse(n("cx"), n("cy"), n("rx"), n("ry"), 0, 0, Math.PI * 2); break;
			case "line": path.moveTo(n("x1"), n("y1")); path.lineTo(n("x2"), n("y2")); break;
			case "polyline": case "polygon": {
				const points = (node.getAttribute("points") ?? "").trim().split(/[ ,]+/).map(Number);
				if (points.length >= 2) { path.moveTo(points[0], points[1]); for (let i = 2; i + 1 < points.length; i += 2) path.lineTo(points[i], points[i + 1]); }
				if (node.localName === "polygon") path.closePath();
				break;
			}
			default: path = null;
		}
	} catch {
		// Skip malformed geometry.
		path = null;
	}
	return {
		fill, stroke, lineWidth: node.getAttribute("stroke-width"),
		cap: cap === "round" || cap === "butt" || cap === "square" ? cap : null,
		join: join === "round" || join === "miter" || join === "bevel" ? join : null,
		opacity: node.getAttribute("opacity"), matrix, path, evenOdd: node.getAttribute("fill-rule") === "evenodd",
		children: Array.from(node.children, (child) => readNode(child, fill, stroke)),
	};
}

function parseIcon(svg: string): ParsedIcon {
	const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
	if (root.localName !== "svg") return null;
	const box = (root.getAttribute("viewBox") ?? "0 0 24 24").trim().split(/[ ,]+/).map(Number);
	if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return null;
	return { box, root: readNode(root, "black", "none") };
}

export function parsedIcon(svg: string): ParsedIcon {
	let entry = parsedIcons.get(svg);
	if (entry !== undefined) {
		// The most recently used is kept longest.
		parsedIcons.delete(svg);
	} else {
		entry = parseIcon(svg);
		if (parsedIcons.size >= PARSED_ICONS_KEPT) parsedIcons.delete(parsedIcons.keys().next().value as string);
	}
	parsedIcons.set(svg, entry);
	return entry;
}

function drawNode(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, node: IconNode, color: string) {
	ctx.save();
	if (node.lineWidth !== null) ctx.lineWidth = Number(node.lineWidth);
	if (node.cap) ctx.lineCap = node.cap;
	if (node.join) ctx.lineJoin = node.join;
	if (node.opacity !== null) ctx.globalAlpha *= Math.max(0, Math.min(1, Number(node.opacity)));
	const m = node.matrix;
	if (m) ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
	if (node.path) {
		try {
			if (node.fill !== "none") { ctx.fillStyle = node.fill === "currentColor" ? color : node.fill; ctx.fill(node.path, node.evenOdd ? "evenodd" : "nonzero"); }
			if (node.stroke !== "none") { ctx.strokeStyle = node.stroke === "currentColor" ? color : node.stroke; ctx.stroke(node.path); }
		} catch { /* Skip malformed geometry. */ }
	}
	for (const child of node.children) drawNode(ctx, child, color);
	ctx.restore();
}

export const iconGraphicDefinition: GraphicDefinition = {
	id: "icon", name: "Icon", nameKey: "params.icon", keywords: ["icon"],
	params: [
		{ key: "color", labelKey: "common.color", type: "color", default: "#ffffff", keyframable: true },
		{ key: "iconName", labelKey: "params.icon", type: "text", default: "" },
		{ key: "svg", labelKey: "params.svg", type: "text", default: "" },
	],
	render({ ctx, params, width, height }) {
		if (typeof DOMParser === "undefined") return;
		const icon = parsedIcon(String(params.svg ?? ""));
		if (!icon) return;
		const { box, root } = icon;
		ctx.save();
		ctx.scale(width / box[2], height / box[3]);
		ctx.translate(-box[0], -box[1]);
		drawNode(ctx, root, String(params.color ?? "#ffffff"));
		ctx.restore();
	},
};
