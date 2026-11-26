import { useI18n } from "@/i18n/provider";
import {
	type ComponentProps,
	forwardRef,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { TimelineManager } from "@/core/managers/timeline-manager";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { startColorDrag, type ColorDragBaseline } from "./color-drag";
import { cn } from "@/utils/ui";
import { Input } from "./input";
import {
	Popover,
	PopoverClose,
	PopoverContent,
	PopoverTrigger,
} from "./popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "./select";
import { Button } from "./button";
import { Cancel01Icon, ColorPickerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type ColorFormat,
	appendAlpha,
	extractColorFromText,
	formatColorValue,
	hexToHsv,
	hsvToHex,
	parseColorInput,
	parseHexAlpha,
} from "@/utils/color";

const CHECKERBOARD_STYLE = {
	backgroundImage: `
    linear-gradient(45deg, rgba(0,0,0,0.1) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(0,0,0,0.1) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.1) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.1) 75%)
  `,
	backgroundSize: "8px 8px",
	backgroundPosition: "0 0, 0 4px, 4px -4px, -4px 0px",
	backgroundColor: "#fff",
} as const;

type ColorDragControl = "saturation" | "hue" | "opacity";

function getDisplayHue(hue: number, saturation: number, internalHue: number): number {
	const hueDiff = Math.abs(hue - internalHue);
	const isSameHueWrapped = hueDiff < 1 || Math.abs(hueDiff - 360) < 1;
	return saturation === 0 || isSameHueWrapped ? internalHue : hue;
}

function blurOnEnter(event: React.KeyboardEvent<HTMLInputElement>) {
	if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
	event.preventDefault();
	event.currentTarget.blur();
}

interface ColorPickerContentProps {
	value?: string;
	onChange?: (value: string) => void;
	onChangeEnd?: (value: string) => void;
	beginDragGesture?: TimelineManager["beginPreviewGesture"];
	readDragBaseline: () => ColorDragBaseline;
	side?: ComponentProps<typeof PopoverContent>["side"];
	align?: ComponentProps<typeof PopoverContent>["align"];
}

function ColorPickerContent({
	value = "FFFFFF",
	onChange,
	onChangeEnd,
	beginDragGesture,
	readDragBaseline,
	side = "left",
	align = "center",
}: ColorPickerContentProps) {
	const { t } = useI18n();
	const drag = useRef<{ target: HTMLButtonElement; cancel: () => void } | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [internalHue, setInternalHue] = useState(0);
	const [inputValue, setInputValue] = useState(value);
	const [colorFormat, setColorFormat] = useState<ColorFormat>("hex");

	// The popover can unmount its buttons while this component stays mounted.
	const trackDragButton = useCallback((target: HTMLButtonElement | null) => {
		if (!target) return;
		return () => {
			if (drag.current?.target === target) drag.current.cancel();
		};
	}, []);

	useLayoutEffect(() => () => drag.current?.cancel(), [beginDragGesture]);

	const isEyeDropperSupported =
		typeof window !== "undefined" && "EyeDropper" in window;

	const { rgb: rgbValue, alpha } = parseHexAlpha({ hex: value });
	const [h, s, v] = hexToHsv({ hex: rgbValue });

	const displayHue = getDisplayHue(h, s, internalHue);

	useEffect(() => {
		setInputValue(formatColorValue({ hex: value, format: colorFormat }));
	}, [value, colorFormat]);

	const handleEyeDropper = async () => {
		if (!isEyeDropperSupported || !EyeDropper) return;
		try {
			const dropper = new EyeDropper();
			const result = await dropper.open();
			const hex = result.sRGBHex.replace("#", "").toLowerCase();
			const finalHex = appendAlpha({ rgbHex: hex, alpha });
			onChange?.(finalHex);
			onChangeEnd?.(finalHex);
		} catch {
			// user cancelled the picker
		}
	};

	const handlePointerDown = (control: ColorDragControl) => (
		event: React.PointerEvent<HTMLButtonElement>,
	) => {
		if (event.button !== 0 || !event.isPrimary || drag.current) return;
		event.preventDefault();
		const target = event.currentTarget;

		const cancel = startColorDrag({
			target,
			startEvent: event,
			beginGesture: beginDragGesture,
			readBaseline: readDragBaseline,
			createColorReader: (baseColor) => {
				const { rgb, alpha } = parseHexAlpha({ hex: baseColor });
				const [h, s, v] = hexToHsv({ hex: rgb });
				const baselineHue = getDisplayHue(h, s, internalHue);
				return ({ clientX, clientY }) => {
					const rect = target.getBoundingClientRect();
					const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
					switch (control) {
						case "saturation": {
							const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
							return appendAlpha({ rgbHex: hsvToHex({ h: baselineHue, s: x, v: 1 - y }), alpha });
						}
						case "hue": {
							const hue = x * 360;
							setInternalHue(hue);
							return s > 0 ? appendAlpha({ rgbHex: hsvToHex({ h: hue, s, v }), alpha }) : null;
						}
						case "opacity":
							return appendAlpha({ rgbHex: rgb, alpha: x });
					}
				};
			},
			onPreview: onChange,
			onCommit: onChangeEnd,
			onEnd: (canceled) => {
				drag.current = null;
				if (canceled && control === "hue") setInternalHue(internalHue);
			},
		});
		drag.current = { target, cancel };
	};

	const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setInputValue(
			colorFormat === "hex"
				? event.target.value.replace("#", "")
				: event.target.value,
		);
	};

	const commitInputValue = () => {
		const parsed = parseColorInput({ input: inputValue, format: colorFormat });
		if (parsed) {
			const nextHex = appendAlpha({ rgbHex: parsed, alpha });
			onChange?.(nextHex);
			onChangeEnd?.(nextHex);
			return;
		}

		const extracted = extractColorFromText({ text: inputValue });
		if (extracted) {
			const hasExplicitAlpha = extracted.length > 6;
			const finalHex = hasExplicitAlpha
				? extracted
				: appendAlpha({ rgbHex: extracted, alpha });
			onChange?.(finalHex);
			onChangeEnd?.(finalHex);
		}
	};

	const handleInputBlur = () => commitInputValue();

	const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
		const pastedText = event.clipboardData.getData("text");
		const extractedHex = extractColorFromText({ text: pastedText });
		if (!extractedHex) return;

		event.preventDefault();
		const hasExplicitAlpha = extractedHex.length > 6;
		const finalHex = hasExplicitAlpha
			? extractedHex
			: appendAlpha({ rgbHex: extractedHex, alpha });
		onChange?.(finalHex);
		onChangeEnd?.(finalHex);
	};

	const saturationStyle = {
		background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${displayHue}, 100%, 50%))`,
	};

	const hueStyle = {
		background:
			"linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)",
	};

	return (
		<PopoverContent
			className="w-64 px-0 select-none flex flex-col gap-3 py-2"
			side={side}
			align={align}
			sideOffset={8}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
			}}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
			}}
			onInteractOutside={(event) => {
				if (drag.current) {
					event.preventDefault();
					return;
				}
				// Pointer-down can dismiss the popover before the browser blurs the input.
				const input = inputRef.current;
				if (input && input.ownerDocument.activeElement === input) input.blur();
			}}
		>
			<header className="border-b flex justify-between items-center pb-2 px-2">
				<Select defaultValue="custom">
					<SelectTrigger variant="outline">
						<SelectValue placeholder={t("settings.colorMode")} />
					</SelectTrigger>
					<SelectContent position="popper">
						<SelectItem value="custom">{t("common.custom")}</SelectItem>
						<SelectItem value="saved">{t("settings.savedColors")}</SelectItem>
					</SelectContent>
				</Select>
				<div>
					{isEyeDropperSupported && (
						<Button
							variant="ghost"
							size="icon"
							type="button"
							onClick={handleEyeDropper}
						>
							<HugeiconsIcon icon={ColorPickerIcon} />
						</Button>
					)}
					<PopoverClose asChild>
						<Button variant="ghost" size="icon" type="button">
							<HugeiconsIcon icon={Cancel01Icon} />
						</Button>
					</PopoverClose>
				</div>
			</header>
			<div className="px-2 flex flex-col gap-3">
				<button
					ref={trackDragButton}
					className="relative touch-none h-44 aspect-square w-full appearance-none border-0 bg-transparent p-0"
					style={saturationStyle}
					type="button"
					onPointerDown={handlePointerDown("saturation")}
				>
					<ColorCircle
						size="sm"
						position={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }}
						color={`#${value}`}
					/>
				</button>

				<button
					ref={trackDragButton}
					className="relative touch-none h-4 w-full rounded-lg appearance-none border-0 bg-transparent p-0"
					style={hueStyle}
					type="button"
					onPointerDown={handlePointerDown("hue")}
				>
					<ColorCircle
						size="md"
						position={{
							left: `calc(0.5rem + (100% - 1rem) * ${displayHue / 360})`,
							top: "50%",
						}}
					/>
				</button>

				<button
					ref={trackDragButton}
					className="relative touch-none h-4 w-full overflow-hidden rounded-lg appearance-none border-0 p-0"
					type="button"
					onPointerDown={handlePointerDown("opacity")}
				>
					<div className="absolute inset-0 dark:invert" style={CHECKERBOARD_STYLE} />
					<div
						className="absolute inset-0 rounded-lg"
						style={{
							background: `linear-gradient(to right, transparent, #${rgbValue})`,
						}}
					/>
					<ColorCircle
						size="md"
						position={{
							left: `calc(0.5rem + (100% - 1rem) * ${alpha})`,
							top: "50%",
						}}
					/>
				</button>

				<div className="flex items-center gap-2">
					<Select
						value={colorFormat}
						onValueChange={(selectedFormat) =>
							setColorFormat(selectedFormat as ColorFormat)
						}
					>
						<SelectTrigger variant="outline" className="min-w-18 max-w-18">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="hex">HEX</SelectItem>
							<SelectItem value="rgb">RGB</SelectItem>
							<SelectItem value="hsl">HSL</SelectItem>
							<SelectItem value="hsv">HSV</SelectItem>
						</SelectContent>
					</Select>

					<Input
						ref={inputRef}
						className={cn(
							"h-7 rounded-sm p-2.5",
							colorFormat === "hex" && "uppercase",
						)}
						type="text"
						value={inputValue}
						onChange={handleInputChange}
						onBlur={handleInputBlur}
						onKeyDown={blurOnEnter}
						onPaste={handlePaste}
					/>
				</div>
			</div>
		</PopoverContent>
	);
}

interface ColorPickerProps {
	value?: string;
	onChange?: (value: string) => void;
	onChangeEnd?: (value: string) => void;
	beginDragGesture?: TimelineManager["beginPreviewGesture"];
	onDragCancel?: (baselineColor: string) => void;
	className?: string;
	contentSide?: ComponentProps<typeof PopoverContent>["side"];
	contentAlign?: ComponentProps<typeof PopoverContent>["align"];
	/** Accessible name of the swatch button and the color field. */
	label?: string;
}

const ColorPicker = forwardRef<HTMLDivElement, ColorPickerProps>(
	(
		{
			className,
			value = "FFFFFF",
			onChange,
			onChangeEnd,
			beginDragGesture,
			onDragCancel,
			contentSide,
			contentAlign,
			label,
			...props
		},
		ref,
	) => {
		const { alpha } = parseHexAlpha({ hex: value });

		const [inputValue, setInputValue] = useState(value);
		const committedColor = useCommittedRef(value);
		const commitColor = (hex: string) => {
			committedColor.current = hex;
			onChangeEnd?.(hex);
		};

		useEffect(() => {
			setInputValue(value);
		}, [value]);

		const commitInputValue = (raw: string) => {
			const input = raw.replace("#", "");
			const parsed = parseColorInput({ input, format: "hex" });
			if (parsed) {
				const nextHex = appendAlpha({ rgbHex: parsed, alpha });
				onChange?.(nextHex);
				commitColor(nextHex);
				return;
			}
			const extracted = extractColorFromText({ text: input });
			if (extracted) {
				const hasExplicitAlpha = extracted.length > 6;
				const finalHex = hasExplicitAlpha
					? extracted
					: appendAlpha({ rgbHex: extracted, alpha });
				onChange?.(finalHex);
				commitColor(finalHex);
			}
		};

		const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
			setInputValue(event.target.value.replace("#", ""));
		};

		const handleInputBlur = () => commitInputValue(inputValue);

		const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
			const pastedText = event.clipboardData.getData("text");
			const extractedHex = extractColorFromText({ text: pastedText });
			if (!extractedHex) return;
			event.preventDefault();
			const hasExplicitAlpha = extractedHex.length > 6;
			const finalHex = hasExplicitAlpha
				? extractedHex
				: appendAlpha({ rgbHex: extractedHex, alpha });
			onChange?.(finalHex);
			commitColor(finalHex);
		};

		return (
			<Popover>
				<div
					ref={ref}
					className={cn(
						"bg-accent flex h-7 border flex-1 items-center gap-2 rounded-md px-[0.45rem]",
						className,
					)}
					{...props}
				>
					<PopoverTrigger asChild>
						<button
							className="size-4.5 relative cursor-pointer overflow-hidden rounded-sm border hover:ring-1 hover:ring-foreground/20"
							type="button"
							aria-label={label}
						>
							<span
								className="absolute inset-0 dark:invert"
								style={CHECKERBOARD_STYLE}
							/>
							<span
								className="absolute inset-0"
								style={{ backgroundColor: `#${value}` }}
							/>
						</button>
					</PopoverTrigger>
					<div className="flex flex-1 items-center">
						<Input
							aria-label={label}
							className="border-0! bg-transparent p-0 ring-0! ring-offset-0! uppercase"
							size="sm"
							containerClassName="w-full"
							value={inputValue}
							onChange={handleInputChange}
							onBlur={handleInputBlur}
							onKeyDown={blurOnEnter}
							onPaste={handlePaste}
						/>
					</div>
				</div>
				<ColorPickerContent
					value={value}
					onChange={onChange}
					onChangeEnd={commitColor}
					beginDragGesture={beginDragGesture}
					readDragBaseline={() => {
						const color = committedColor.current;
						return { color, restore: () => onDragCancel?.(color) };
					}}
					side={contentSide}
					align={contentAlign}
				/>
			</Popover>
		);
	},
);
ColorPicker.displayName = "ColorPicker";

const ColorCircle = ({
	size,
	position,
	color,
}: {
	size: "sm" | "md";
	position: { left: string; top: string };
	color?: string;
}) => (
	<div
		className={cn(
			"pointer-events-none absolute rounded-full border-3 border-white shadow-lg",
			size === "sm" ? "size-3" : "size-4",
		)}
		style={{
			left: position.left,
			top: position.top,
			transform: "translate(-50%, -50%)",
			backgroundColor: color,
		}}
	/>
);

export { ColorPicker, ColorPickerContent };
