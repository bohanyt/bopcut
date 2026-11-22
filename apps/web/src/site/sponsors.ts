import type { StaticMessageKey } from "@/i18n/translate";

export type Sponsor = {
	name: string;
	url: string;
	logo: string;
	description: StaticMessageKey;
	invertOnDark?: boolean;
};

export const SPONSORS: Sponsor[] = [
	{
		name: "Fal.ai",
		url: "https://fal.ai?utm_source=opencut",
		logo: "/logos/others/fal.svg",
		description: "sponsors.fal",
		invertOnDark: true,
	},
	{
		name: "Vercel",
		url: "https://vercel.com?utm_source=opencut",
		logo: "/logos/others/vercel.svg",
		description: "sponsors.vercel",
		invertOnDark: true,
	},
];
