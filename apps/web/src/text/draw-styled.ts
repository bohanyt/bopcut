import type { MeasuredTextElement } from "./measure-element";
import { drawMeasuredTextLayout } from "./primitives";
import {
	drawTextDecoration,
	setCanvasLetterSpacing,
	type TextCanvasContext,
} from "./layout";

function surface(
	width: number,
	height: number,
): OffscreenCanvas | HTMLCanvasElement {
	if (typeof OffscreenCanvas !== "undefined")
		return new OffscreenCanvas(width, height);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

type Surface = OffscreenCanvas | HTMLCanvasElement;

/** Larger scratch surfaces are made for one draw and dropped, so the cache stays at a few megabytes. */
const MAX_SCRATCH_PIXELS = 2048 * 2048;
const scratch: { glyphs?: Surface; shade?: Surface } = {};
const prepared = new WeakSet<Surface>();

/**
 * A cleared drawing area of at least width × height. Shadowed text redraws every frame, so its two
 * surfaces are reused instead of allocated each time; only the top-left width × height is used.
 */
function scratchSurface(slot: "glyphs" | "shade", width: number, height: number): { canvas: Surface; ctx: TextCanvasContext | null } {
	let canvas = scratch[slot];
	if (!canvas || canvas.width < width || canvas.height < height) {
		canvas = surface(Math.max(width, canvas?.width ?? 0), Math.max(height, canvas?.height ?? 0));
		if (canvas.width * canvas.height <= MAX_SCRATCH_PIXELS) scratch[slot] = canvas;
		else canvas = surface(width, height);
	}
	const ctx = canvas.getContext("2d") as TextCanvasContext | null;
	if (ctx) {
		// Behave like a fresh surface of exactly this size: the default state saved at first use,
		// empty everywhere (a blur may read past the used part), and nothing drawn outside the used part.
		if (prepared.has(canvas)) ctx.restore();
		else prepared.add(canvas);
		ctx.save();
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.beginPath();
		ctx.rect(0, 0, width, height);
		ctx.clip();
	}
	return { canvas, ctx };
}

function drawGlyphs(
	ctx: TextCanvasContext,
	layout: MeasuredTextElement,
	color: string,
	baseline: CanvasTextBaseline,
) {
	ctx.save();
	ctx.font = layout.fontString;
	ctx.textBaseline = baseline;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });
	const typing = (layout.typed ?? 1) < 1;
	const lineRuns = () =>
		layout.lines.map((text, index) => ({
			text,
			index: -1,
			// While typing, each line is drawn from its own edge, so its letters stay where they are.
			x: typing && layout.textAlign !== "left" ? -layout.lineMetrics[index].width / (layout.textAlign === "center" ? 2 : 1) : 0,
			y: index * layout.lineHeightPx - layout.block.visualCenterOffset,
			width: layout.lineMetrics[index].width,
		}));
	const runs = typing ? typedRuns(layout.wordRuns ?? lineRuns(), layout.typed) : (layout.wordRuns ?? lineRuns());
	ctx.textAlign = layout.wordRuns || typing ? "left" : layout.textAlign;
	const draw = (stroke?: { color: string; width: number }) => {
		for (const run of runs) {
			const active =
				layout.style.activeEnabled &&
				run.index >= 0 &&
				run.index === layout.activeWord;
			// Words not yet spoken stay hidden; appearing words fade (and pop) in, ease-out.
			const shown = run.index >= 0 ? (layout.wordReveal?.[run.index] ?? 1) : 1;
			if (shown <= 0) continue;
			ctx.save();
			// A right-to-left run being typed grows from its right edge (where its first letters are).
			const fromRight = typing && "rtl" in run && run.rtl;
			ctx.translate(fromRight ? run.x + run.width : run.x, run.y);
			if (fromRight) ctx.textAlign = "right";
			let scale = active ? layout.style.activeScale : 1;
			if (shown < 1) {
				const eased = 1 - (1 - shown) ** 3;
				ctx.globalAlpha *= eased;
				scale *= layout.style.revealPop + (1 - layout.style.revealPop) * eased;
			}
			if (scale !== 1) {
				const middle = fromRight ? -run.width / 2 : run.width / 2;
				ctx.translate(middle, 0);
				ctx.scale(scale, scale);
				ctx.translate(-middle, 0);
			}
			if (stroke) {
				ctx.strokeStyle = stroke.color;
				// Canvas strokes straddle the glyph edge; public widths describe the outward radius.
				ctx.lineWidth = stroke.width * 2;
				ctx.strokeText(run.text, 0, 0);
			} else {
				ctx.fillStyle = active
					? layout.style.activeColor
					: layout.emphasisWords.includes(run.index)
						? layout.style.highlightColor
						: color;
				ctx.fillText(run.text, 0, 0);
			}
			ctx.restore();
		}
	};
	for (const stroke of layout.style.strokes) if (stroke.width > 0) draw(stroke);
	draw();
	ctx.fillStyle = color;
	// Underlines and strikes come with the whole text, not before its letters.
	if (!typing) for (let i = 0; i < layout.lines.length; i++)
		drawTextDecoration({
			ctx,
			textDecoration: layout.textDecoration,
			lineWidth: layout.lineMetrics[i].width,
			lineY: i * layout.lineHeightPx - layout.block.visualCenterOffset,
			metrics: layout.lineMetrics[i],
			scaledFontSize: layout.scaledFontSize,
			textAlign: layout.textAlign,
		});
	ctx.restore();
}

// The first strong letter of a text decides its direction (Hebrew, Arabic and nearby scripts are right to left).
const STRONG = /\p{L}/u;
const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LTR = /(?![\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF])\p{L}/u;
let graphemeSegmenter: Intl.Segmenter | undefined;

function revealCharacters(text: string): string[] {
	if (!/[^\x00-\x7F]/.test(text) || typeof Intl.Segmenter !== "function") {
		return Array.from(text);
	}
	graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
	return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

/**
 * The runs cut to the first `typed` share of their characters (in reading order); a right-to-left run is
 * marked so it is drawn from its right edge.
 */
function typedRuns<T extends { text: string }>(runs: T[], typed: number): (T & { rtl: boolean })[] {
	const segmented = runs.map((run) => ({ run, characters: revealCharacters(run.text) }));
	const total = segmented.reduce((sum, { characters }) => sum + characters.length, 0);
	let left = Math.floor(typed * total + 1e-9);
	const shown: (T & { rtl: boolean })[] = [];
	for (const { run, characters } of segmented) {
		if (left <= 0) break;
		const rtl = RTL.test(STRONG.exec(run.text)?.[0] ?? "");
		const whole = characters.length <= left;
		// A run mixing both directions would reorder as it grows: it appears whole once it is typed.
		const mixed = !whole && RTL.test(run.text) && LTR.test(run.text);
		if (!mixed) shown.push({ ...run, text: whole ? run.text : characters.slice(0, left).join(""), rtl });
		left -= characters.length;
	}
	return shown;
}

/** Rasterize the combined glyph alpha once, so overlapping rings cast one shadow. */
export function drawStyledText({
	ctx,
	layout,
	textColor,
	backgroundColor,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextElement;
	textColor: string;
	backgroundColor: string;
	textBaseline?: CanvasTextBaseline;
}): void {
	// The background is separate from the glyph silhouette.
	drawMeasuredTextLayout({
		ctx,
		layout,
		textColor,
		background: layout.resolvedBackground,
		backgroundColor,
		textBaseline,
		drawText: false,
	});
	const shadow = layout.style.shadow;
	if (shadow.opacity <= 0) {
		drawGlyphs(ctx, layout, textColor, textBaseline);
		return;
	}
	const rect = layout.visualRect;
	const transform = ctx.getTransform();
	const scale = Math.max(
		0.01,
		Math.hypot(transform.a, transform.b),
		Math.hypot(transform.c, transform.d),
	);
	// Guard browser canvas limits for extreme transforms; preserve logical geometry.
	const rasterScale = Math.min(
		scale,
		8192 / Math.max(1, rect.width, rect.height),
	);
	const width = Math.max(1, Math.ceil(rect.width * rasterScale));
	const height = Math.max(1, Math.ceil(rect.height * rasterScale));
	const { canvas: glyphs, ctx: ink } = scratchSurface("glyphs", width, height);
	if (!ink) return;
	ink.scale(rasterScale, rasterScale);
	ink.translate(-rect.left, -rect.top);
	drawGlyphs(ink, layout, textColor, textBaseline);
	const { canvas: shade, ctx: mask } = scratchSurface("shade", width, height);
	if (!mask) return;
	mask.filter =
		shadow.blur > 0 ? `blur(${shadow.blur * rasterScale}px)` : "none";
	// Only the used part of a reused surface is copied, so the result is the same as on a fresh one.
	mask.drawImage(
		glyphs,
		0, 0, width, height,
		shadow.offsetX * rasterScale,
		shadow.offsetY * rasterScale,
		width, height,
	);
	mask.filter = "none";
	mask.globalCompositeOperation = "source-in";
	mask.fillStyle = shadow.color;
	mask.fillRect(0, 0, width, height);
	ctx.save();
	ctx.globalAlpha *= shadow.opacity;
	ctx.drawImage(
		shade,
		0, 0, width, height,
		rect.left,
		rect.top,
		width / rasterScale,
		height / rasterScale,
	);
	ctx.restore();
	ctx.drawImage(
		glyphs,
		0, 0, width, height,
		rect.left,
		rect.top,
		width / rasterScale,
		height / rasterScale,
	);
}
