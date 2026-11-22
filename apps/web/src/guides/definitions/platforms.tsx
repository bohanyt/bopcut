import type { StaticMessageKey } from "@/i18n/translate";
import Image from "next/image";
import type { GuideDefinition } from "@/guides/types";
import { TikTokLayout } from "./tiktok-layout";

function PlatformLogo({
	domain,
	className = "size-4",
}: {
	domain: string;
	className?: string;
}) {
	return (
		<Image
			src={`https://cdn.brandfetch.io/${domain}/w/64/h/64`}
			alt=""
			width={18}
			height={18}
			className={className}
			draggable={false}
			unoptimized
		/>
	);
}

function PlatformGuidePreview({ domain }: { domain: string }) {
	return <PlatformLogo domain={domain} />;
}

function platformGuide({
	id,
	labelKey,
	domain,
}: {
	id: string;
	labelKey: StaticMessageKey;
	domain: string;
}): GuideDefinition {
	return {
		id,
		labelKey,
		renderPreview: () => <PlatformGuidePreview domain={domain} />,
		renderTriggerIcon: () => <PlatformLogo domain={domain} />,
		renderOverlay: () => null,
	};
}

export const tiktokGuide: GuideDefinition = {
	...platformGuide({ id: "tiktok", labelKey: "guides.tiktok", domain: "tiktok.com" }),
	renderOverlay: () => <TikTokLayout />,
};
export const igReelsGuide = platformGuide({
	id: "ig-reels",
	labelKey: "guides.reels",
	domain: "instagram.com",
});
export const ytShortsGuide = platformGuide({
	id: "yt-shorts",
	labelKey: "guides.shorts",
	domain: "youtube.com",
});
export const spotlightGuide = platformGuide({
	id: "spotlight",
	labelKey: "guides.spotlight",
	domain: "snapchat.com",
});
