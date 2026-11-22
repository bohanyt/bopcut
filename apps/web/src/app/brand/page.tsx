"use client";

import { useI18n } from "@/i18n/provider";

import type { StaticMessageKey } from "@/i18n/translate";
import type { CSSProperties } from "react";
import Image from "next/image";
import Link from "next/link";
import { Check, Copy, Download } from "lucide-react";
import { useState } from "react";
import { BasePage } from "@/app/base-page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/utils/ui";

function downloadAsset(src: string) {
	const filename = src.split("/").pop() ?? "asset.svg";
	const a = document.createElement("a");
	a.href = src;
	a.download = filename;
	a.click();
}

async function copyAsset(src: string) {
	const res = await fetch(src);
	const text = await res.text();
	await navigator.clipboard.writeText(text);
}

const ALL_ASSETS = () => ASSET_SECTIONS.flatMap((s) => s.assets);

type AssetTheme = "dark" | "light" | "icon";

interface AssetVariant {
	src: string;
	theme: AssetTheme;
	label: StaticMessageKey;
	width: number;
	height: number;
}

interface AssetSection {
	title: StaticMessageKey;
	description: StaticMessageKey;
	cols: "1" | "2";
	assets: AssetVariant[];
}

const ASSET_SECTIONS: AssetSection[] = [
	{
		title: "brand.symbol",
		description:
			"brand.symbolDescription",
		cols: "2",
		assets: [
			{
				src: "/logos/opencut/symbol.svg",
				theme: "dark",
				label: "brand.symbol",
				width: 400,
				height: 400,
			},
			{
				src: "/logos/opencut/symbol-light.svg",
				theme: "light",
				label: "brand.symbol",
				width: 400,
				height: 400,
			},
		],
	},
	{
		title: "brand.lockup",
		description:
			"brand.lockupDescription",
		cols: "2",
		assets: [
			{
				src: "/logos/opencut/logo.svg",
				theme: "dark",
				label: "brand.logo",
				width: 1809,
				height: 400,
			},
			{
				src: "/logos/opencut/logo-light.svg",
				theme: "light",
				label: "brand.logo",
				width: 1809,
				height: 400,
			},
			{
				src: "/logos/opencut/text.svg",
				theme: "dark",
				label: "brand.wordmark",
				width: 1760,
				height: 400,
			},
			{
				src: "/logos/opencut/text-light.svg",
				theme: "light",
				label: "brand.wordmark",
				width: 1760,
				height: 400,
			},
		],
	},
];

export default function BrandPage() {
	const { t } = useI18n();
	return (
		<BasePage
			maxWidth="6xl"
			title={t("footer.brand")}
			description={
				<>
					{t("brand.intro")}{" "}
					<Link
						href="#guidelines"
						className="underline underline-offset-4"
						onClick={() =>
							document
								.getElementById("guidelines")
								?.scrollIntoView({ behavior: "smooth" })
						}
					>
						{t("brand.readGuidelines")}
					</Link>
				</>
			}
			action={
				<Button
					variant="outline"
					size="lg"
					className="mx-auto gap-2"
					onClick={() => {
						ALL_ASSETS().forEach((asset, i) => {
							setTimeout(() => downloadAsset(asset.src), i * 200);
						});
					}}
				>
					<Download />
					{t("brand.downloadAll")}
				</Button>
			}
		>
			<div className="flex flex-col gap-10">
				{ASSET_SECTIONS.map((section) => (
					<div key={section.title} className="flex flex-col gap-4">
						<div className="flex flex-col gap-1">
							<h2 className="font-semibold text-lg">{t(section.title)}</h2>
							<p className="text-muted-foreground text-sm">
								{t(section.description)}
							</p>
						</div>
						<div
							className={cn(
								"grid gap-3",
								section.cols === "2"
									? "grid-cols-1 sm:grid-cols-2"
									: "grid-cols-1",
							)}
						>
							{section.assets.map((variant) => (
								<AssetCard key={variant.src} variant={variant} />
							))}
						</div>
					</div>
				))}
			</div>

			<Separator />

			<div id="guidelines" className="flex flex-col gap-8 text-sm">
				<div className="flex flex-col gap-3">
					<h2 className="font-semibold text-lg">{t("brand.usage")}</h2>
					<p className="text-muted-foreground text-base leading-relaxed">
						{t("brand.usageRules")}{" "}
						<Link
							href="mailto:brand@opencut.app"
							className="underline underline-offset-4"
						>
							brand@opencut.app
						</Link>
						.
					</p>
				</div>

				<div className="flex flex-col gap-3">
					<h2 className="font-semibold text-lg">{t("brand.prohibited")}</h2>
					<ul className="text-muted-foreground text-base flex flex-col gap-2 leading-relaxed">
						{[
							t("brand.productName"),
							t("brand.endorsement"),
							t("brand.marketing"),
							t("brand.modify"),
						].map((item) => (
							<li key={item} className="flex gap-2">
								<span className="mt-0.5 shrink-0">-</span>
								<span>{item}</span>
							</li>
						))}
					</ul>
				</div>
			</div>
		</BasePage>
	);
}

const CHECKER_STYLES: Record<"dark" | "light", CSSProperties> = {
	light: {
		backgroundImage:
			"linear-gradient(45deg, #292929 25%, transparent 25%), linear-gradient(-45deg, #292929 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #292929 75%), linear-gradient(-45deg, transparent 75%, #292929 75%)",
		backgroundSize: "18px 18px",
		backgroundPosition: "0 0, 0 9px, 9px -9px, -9px 0px",
		backgroundColor: "#000",
	},
	dark: {
		backgroundImage:
			"linear-gradient(45deg, #e0e0e0 25%, transparent 25%), linear-gradient(-45deg, #e0e0e0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e0e0e0 75%), linear-gradient(-45deg, transparent 75%, #e0e0e0 75%)",
		backgroundSize: "18px 18px",
		backgroundPosition: "0 0, 0 9px, 9px -9px, -9px 0px",
		backgroundColor: "#f5f5f5",
	},
};

function AssetCard({ variant }: { variant: AssetVariant }) {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);

	async function handleCopy() {
		await copyAsset(variant.src);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	return (
		<Card
			className="group relative overflow-hidden"
			style={
				variant.theme === "icon" ? undefined : CHECKER_STYLES[variant.theme]
			}
		>
			<div className="flex h-56 items-center justify-center px-12 py-8">
				<Image
					src={variant.src}
					alt={t(variant.label)}
					width={variant.width}
					height={variant.height}
					className="max-h-16 w-auto select-none object-contain"
					draggable={false}
					unoptimized
				/>
			</div>

			<Button
				variant="outline"
				aria-label={t("header.copySvg")}
				size="icon"
				className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 size-9"
				onClick={handleCopy}
			>
				{copied ? <Check /> : <Copy />}
			</Button>
		</Card>
	);
}
