import type { StaticMessageKey, createTranslator } from "@/i18n/translate";
import { getServerI18n } from "@/i18n/server";
import type { Metadata } from "next";
import { BasePage } from "@/app/base-page";
import { GitHubContributeSection } from "@/components/gitHub-contribute-section";
import { Badge } from "@/components/ui/badge";
import { ReactMarkdownWrapper } from "@/components/ui/react-markdown-wrapper";
import { cn } from "@/utils/ui";

type StatusType = "complete" | "pending" | "default" | "info";

interface Status {
	text: StaticMessageKey;
	type: StatusType;
}

interface RoadmapItem {
	title: StaticMessageKey;
	description: StaticMessageKey;
	status: Status;
}

const roadmapItems: RoadmapItem[] = [
	{
		title: "roadmap.start",
		description:
			"roadmap.startDescription",
		status: {
			text: "roadmap.complete",
			type: "complete",
		},
	},
	{
		title: "roadmap.core",
		description:
			"roadmap.coreDescription",
		status: {
			text: "roadmap.complete",
			type: "complete",
		},
	},
	{
		title: "roadmap.essential",
		description:
			"roadmap.essentialDescription",
		status: {
			text: "roadmap.pending",
			type: "pending",
		},
	},
	{
		title: "roadmap.native",
		description:
			"roadmap.nativeDescription",
		status: {
			text: "roadmap.notStarted",
			type: "default",
		},
	},
];

const metadata: Metadata = {
	title: "Roadmap - OpenCut",
	description:
		"See what's coming next for OpenCut - the free, open-source video editor that respects your privacy.",
	openGraph: {
		title: "OpenCut Roadmap - What's Coming Next",
		description:
			"See what's coming next for OpenCut - the free, open-source video editor that respects your privacy.",
		type: "website",
		images: [
			{
				url: "/open-graph/roadmap.jpg",
				width: 1200,
				height: 630,
				alt: "OpenCut Roadmap",
			},
		],
	},
	twitter: {
		card: "summary_large_image",
		title: "OpenCut Roadmap - What's Coming Next",
		description:
			"See what's coming next for OpenCut - the free, open-source video editor that respects your privacy.",
		images: ["/open-graph/roadmap.jpg"],
	},
};

export async function generateMetadata(): Promise<Metadata> {
	const { t } = await getServerI18n();
	return {
		...metadata,
		title: t("site.pageTitle", { title: t("header.roadmap") }),
	};
}

export default async function RoadmapPage() {
	const { t } = await getServerI18n();
	return (
		<BasePage
			title={t("header.roadmap")}
			description={t("roadmap.description", { date: t("roadmap.date") })}
		>
			<div className="mx-auto flex max-w-4xl flex-col gap-16">
				<div className="flex flex-col gap-6">
					{roadmapItems.map((item, index) => (
						<RoadmapItem key={item.title} item={item} index={index} t={t} />
					))}
				</div>
				<GitHubContributeSection
					title={t("roadmap.help")}
					description={t("roadmap.helpDescription")}
				/>
			</div>
		</BasePage>
	);
}

function RoadmapItem({ item, index, t }: { item: RoadmapItem; index: number; t: ReturnType<typeof createTranslator> }) {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-lg font-medium">
				<span className="leading-normal select-none">{index + 1}</span>
				<h3>{t(item.title)}</h3>
				<StatusBadge status={item.status} text={t(item.status.text)} className="ml-1" />
			</div>
			<div className="text-foreground/70 leading-relaxed">
				<ReactMarkdownWrapper>{t(item.description)}</ReactMarkdownWrapper>
			</div>
		</div>
	);
}

function StatusBadge({
	status,
	text,
	className,
}: {
	status: Status;
	text: string;
	className?: string;
}) {
	return (
		<Badge
			className={cn("shadow-none", className, {
				"bg-green-500! text-white": status.type === "complete",
				"bg-yellow-500! text-white": status.type === "pending",
				"bg-blue-500! text-white": status.type === "info",
				"bg-foreground/10! text-accent-foreground": status.type === "default",
			})}
		>
			{text}
		</Badge>
	);
}
