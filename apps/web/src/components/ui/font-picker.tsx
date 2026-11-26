"use client";

import { useI18n } from "@/i18n/provider";
import { useState, useMemo, useRef, useEffect, useCallback, type CSSProperties } from "react";
import { List, type RowComponentProps } from "react-window";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { loadFullFont } from "@/fonts/google-fonts";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";
import type { FontAtlas, FontAtlasEntry } from "@/fonts/types";
import { useFontAtlas } from "@/fonts/use-font-atlas";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { cn } from "@/utils/ui";
import { ChevronDown, Search } from "lucide-react";
import { HugeiconsIcon } from "@hugeicons/react";
import { TextIcon } from "@hugeicons/core-free-icons";

const FONT_TABS = [
	{ key: "all", labelKey: "text.allFonts", searchKey: "text.searchAllFonts" },
	{ key: "my-fonts", labelKey: "text.myFonts", searchKey: "text.searchMyFonts" },
	{ key: "favorites", labelKey: "text.favoriteFonts", searchKey: "text.searchFavoriteFonts" },
] as const;

type FontTab = (typeof FONT_TABS)[number]["key"];

const ROW_HEIGHT = 40;
const PREVIEW_SCALE = 0.8;
const LIST_WIDTH = 288;
const MAX_LIST_HEIGHT = 288;
const OVERSCAN = 15;

/**
 * A family the list does not have (a font installed on this computer) can still be typed: the search
 * text is offered as a family when no listed font has exactly that name.
 */
export function typedFamilyToOffer({ search, fontNames }: { search: string; fontNames: readonly string[] }): string | null {
	const family = search.trim();
	if (!family) return null;
	const key = family.toLowerCase();
	return fontNames.some((name) => name.toLowerCase() === key) ? null : family;
}

interface FontPickerProps {
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	className?: string;
	/** The field's accessible name; the trigger shows only the font. */
	label?: string;
}

export function FontPicker({
	defaultValue,
	onValueChange,
	className,
	label,
}: FontPickerProps) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [activeTab, setActiveTab] = useState<FontTab>("all");
	const searchInputRef = useRef<HTMLInputElement>(null);
	const { atlas, status, fontNames, retry: handleRetry } = useFontAtlas({ open });

	const filteredFonts = useMemo(() => {
		if (!search) return fontNames;
		const query = search.toLowerCase();
		return fontNames.filter((name) => name.toLowerCase().includes(query));
	}, [fontNames, search]);
	const typedFamily = typedFamilyToOffer({ search, fontNames });

	const pendingChoice = useRef<AbortController | null>(null);
	const notifyChoice = useCommittedRef(onValueChange);

	const listHeight = Math.min(
		MAX_LIST_HEIGHT,
		filteredFonts.length * ROW_HEIGHT,
	);

	const handleSelect = useCallback(
		async ({ family, load = true }: { family: string; load?: boolean }) => {
			pendingChoice.current?.abort();
			const choice = new AbortController();
			pendingChoice.current = choice;
			if (load && !SYSTEM_FONTS.has(family)) {
				try {
					await loadFullFont({ family });
				} catch {
					// ignore load failure, font will fall back to system default
				}
			}
			if (choice.signal.aborted) return;
			pendingChoice.current = null;
			notifyChoice.current?.(family);
			setOpen(false);
		},
		[notifyChoice],
	);

	useEffect(() => {
		if (!open) {
			setSearch("");
			setActiveTab("all");
		}
	}, [open]);
	useEffect(() => () => pendingChoice.current?.abort(), []);

	const activeFontTab = FONT_TABS.find((tab) => tab.key === activeTab) ?? FONT_TABS[0];

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				aria-label={label ? `${label}: ${defaultValue ?? t("text.selectFont")}` : undefined}
				className={cn(
					"border-border bg-accent flex h-7 w-full cursor-pointer items-center justify-between gap-1 rounded-md border px-2.5 text-sm whitespace-nowrap focus-visible:border-primary focus-visible:ring-0 focus:outline-hidden",
					className,
				)}
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="text-muted-foreground [&_svg]:size-3.5 shrink-0">
						<HugeiconsIcon icon={TextIcon} />
					</span>
					<span className="truncate" style={{ fontFamily: defaultValue }}>
						{defaultValue ?? t("text.selectFont")}
					</span>
				</div>
				<ChevronDown className="size-3 shrink-0 opacity-50" />
			</PopoverTrigger>
			<PopoverContent
				className="w-72 p-0 overflow-hidden"
				align="start"
				side="left"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					searchInputRef.current?.focus();
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					event.stopPropagation();
				}}
			>
				<div className="relative px-3 py-1.5">
					<Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 shrink-0 opacity-50" />
					<Input
						ref={searchInputRef}
						placeholder={t(activeFontTab.searchKey)}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						size="xs"
						className="w-full pl-5 bg-transparent border-none! shadow-none!"
					/>
				</div>
				<div className="flex border-b px-3">
					{FONT_TABS.map((tab) => (
						<button
							key={tab.key}
							type="button"
							className={cn(
								"px-3 py-1.5 text-xs border-b-2 -mb-px",
								activeTab === tab.key
									? "border-foreground text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground",
							)}
							onClick={() => setActiveTab(tab.key)}
						>
							{t(tab.labelKey)}
						</button>
					))}
				</div>
				{status === "loading" && (
					<div className="py-8 text-center text-sm text-muted-foreground">
						{t("text.loadingFonts")}
					</div>
				)}
				{status === "error" && (
					<div className="flex flex-col items-center gap-3 py-8 px-4">
						<p className="text-sm text-muted-foreground text-center">
							{t("text.fontPreviewFailed")}
						</p>
						<Button variant="outline" size="sm" onClick={handleRetry}>
							{t("text.retryFonts")}
						</Button>
					</div>
				)}
				{status === "idle" &&
					fontNames.length > 0 &&
					filteredFonts.length === 0 && (
						<div className="py-6 text-center text-sm text-muted-foreground">
							{t("text.noFonts")}
						</div>
					)}
				{status === "idle" && atlas && filteredFonts.length > 0 && (
					<List
						rowCount={filteredFonts.length}
						rowHeight={ROW_HEIGHT}
						overscanCount={OVERSCAN}
						rowComponent={FontRow}
						rowProps={{
							atlas,
							filteredFonts,
							selectedFont: defaultValue,
							onFontSelect: handleSelect,
						}}
						style={{ height: listHeight, width: LIST_WIDTH }}
					/>
				)}
				{typedFamily && (
					<button
						type="button"
						className="hover:bg-accent w-full truncate border-t px-3 py-2 text-left text-sm"
						// Not in the web font list, so not fetched from it: a font installed on this computer.
						onClick={() => handleSelect({ family: typedFamily, load: false })}
					>
						{t("text.useTypedFont", { name: typedFamily })}
					</button>
				)}
			</PopoverContent>
		</Popover>
	);
}

function FontSpritePreview({ entry }: { entry: FontAtlasEntry }) {
	return (
		<div
			className="shrink-0"
			style={{
				width: entry.w,
				height: ROW_HEIGHT,
				backgroundColor: "currentColor",
				WebkitMaskImage: `url(/fonts/font-chunk-${entry.ch}.avif)`,
				WebkitMaskPosition: `-${entry.x}px -${entry.y}px`,
				WebkitMaskRepeat: "no-repeat",
				maskImage: `url(/fonts/font-chunk-${entry.ch}.avif)`,
				maskPosition: `-${entry.x}px -${entry.y}px`,
				maskRepeat: "no-repeat",
				transform: `scale(${PREVIEW_SCALE})`,
				transformOrigin: "left center",
			}}
		/>
	);
}

type FontRowProps = {
	atlas: FontAtlas;
	filteredFonts: string[];
	selectedFont: string | undefined;
	onFontSelect: (params: { family: string }) => void;
};

function FontRow({
	index,
	style,
	atlas,
	filteredFonts,
	selectedFont,
	onFontSelect,
}: RowComponentProps<FontRowProps>) {
	const fontName = filteredFonts[index];
	const entry = atlas.fonts[fontName];
	const isSelected = fontName === selectedFont;
	const isSystemFont = SYSTEM_FONTS.has(fontName);

	return (
		<button
			type="button"
			style={style as CSSProperties}
			className={cn(
				"flex w-full cursor-pointer items-center gap-2 px-3 outline-hidden hover:bg-popover-hover",
				isSelected && "bg-popover-hover",
			)}
			onClick={() => onFontSelect({ family: fontName })}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onFontSelect({ family: fontName });
				}
			}}
			aria-label={fontName}
		>
			<div className="min-w-0 overflow-hidden">
				{isSystemFont ? (
					<span className="text-xl text-foreground/85" style={{ fontFamily: fontName }}>
						{fontName}
					</span>
				) : (
					<FontSpritePreview entry={entry} />
				)}
			</div>
		</button>
	);
}
