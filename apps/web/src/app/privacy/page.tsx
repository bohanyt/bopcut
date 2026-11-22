import { getServerI18n } from "@/i18n/server";
import type { Metadata } from "next";
import { BasePage } from "@/app/base-page";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Separator } from "@/components/ui/separator";
import { SOCIAL_LINKS } from "@/site/social";

const metadata: Metadata = {
	title: "Privacy Policy - OpenCut",
	description:
		"Learn how OpenCut handles your data and privacy. Our commitment to protecting your information while you edit videos.",
	openGraph: {
		title: "Privacy Policy - OpenCut",
		description:
			"Learn how OpenCut handles your data and privacy. Our commitment to protecting your information while you edit videos.",
		type: "website",
	},
};

export async function generateMetadata(): Promise<Metadata> {
	const { t } = await getServerI18n();
	return {
		...metadata,
		title: t("site.pageTitle", { title: t("privacy.title") }),
		description: t("privacy.description"),
	};
}

export default async function PrivacyPage() {
	const { t } = await getServerI18n();
	return (
		<BasePage
			title={t("privacy.title")}
			description={t("privacy.description")}
		>
			<Accordion type="single" collapsible className="w-full">
				<AccordionItem
					value="quick-summary"
					className="rounded-2xl border px-5"
				>
					<AccordionTrigger className="no-underline!">
						{t("privacy.summary")}
					</AccordionTrigger>
					<AccordionContent>
						<h3 className="mb-3 text-lg font-medium">
							{t("privacy.contentStays")}
						</h3>
						<ol className="list-decimal space-y-2 pl-6">
							<li>
								{t("privacy.localEditing")}
							</li>
							<li>
								{t("privacy.localCaptions")}
							</li>
							<li>
								{t("privacy.noAccount")}
							</li>
							<li>{t("privacy.projectData")}</li>
							<li>
								{t("privacy.anonymous")}
							</li>
							<li>{t("privacy.clearData")}</li>
							<li>
								{t("privacy.noDataSale")}
							</li>
						</ol>
						<p className="mt-4">
							{t("privacy.questions")}{" "}
							<a
								href="mailto:oss@opencut.app"
								className="text-primary hover:underline"
							>
								oss@opencut.app
							</a>
						</p>
					</AccordionContent>
				</AccordionItem>
			</Accordion>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("privacy.contentHeading")}</h2>
				<p>
					<strong>
						{t("privacy.localProcessing")}
					</strong>{" "}
					{t("privacy.contentPrivacy")}
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("privacy.accountsHeading")}</h2>
				<p>
					{t("privacy.accounts")}
				</p>
				<p>
					{t("privacy.identity")}
				</p>
				<p>
					{t("privacy.projectStorage")}
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("privacy.analyticsHeading")}</h2>
				<p>
					{t("privacy.analyticsBefore")}{" "}
					<a
						href="https://www.databuddy.cc"
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary hover:underline"
					>
						Databuddy
					</a>{" "}
					{t("privacy.analyticsAfter")}
				</p>
				<p>
					{t("privacy.tracking")}
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("privacy.storageHeading")}</h2>
				<p>{t("privacy.storageIntro")}</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>{t("privacy.saveLocal")}</li>
					<li>{t("privacy.rememberPreferences")}</li>
					<li>{t("privacy.rememberState")}</li>
				</ul>
				<p>
					{t("privacy.storagePrivacy")}
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("privacy.thirdPartyHeading")}</h2>
				<p>{t("privacy.thirdPartyIntro")}</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>
						<strong>Vercel:</strong> {t("privacy.hosting")}
					</li>
					<li>
						<strong>Databuddy:</strong> {t("privacy.anonymousAnalytics")}
					</li>
				</ul>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("privacy.rightsHeading")}</h2>
				<p>{t("privacy.rightsIntro")}</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>{t("privacy.accountRight")}</li>
					<li>{t("privacy.clearRight")}</li>
					<li>{t("privacy.contactRight")}</li>
				</ul>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("privacy.sourceHeading")}</h2>
				<p>
					{t("privacy.source")}
				</p>
				<p>
					{t("privacy.viewSource")}{" "}
					<a
						href={SOCIAL_LINKS.github}
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary hover:underline"
					>
						GitHub
					</a>
					.
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("privacy.contactHeading")}</h2>
				<p>{t("privacy.contactQuestions")}</p>
				<p>
					{t("privacy.openIssue")}{" "}
					<a
						href={`${SOCIAL_LINKS.github}/issues`}
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary hover:underline"
					>
						{t("privacy.repository")}
					</a>
					{t("privacy.email")}{" "}
					<a
						href="mailto:oss@opencut.app"
						className="text-primary hover:underline"
					>
						oss@opencut.app
					</a>
					{t("privacy.social")}{" "}
					<a
						href={SOCIAL_LINKS.x}
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary hover:underline"
					>
						X (Twitter)
					</a>
					.
				</p>
			</section>

			<Separator />

			<p className="text-muted-foreground text-sm">
				{t("privacy.date")}
			</p>
		</BasePage>
	);
}
