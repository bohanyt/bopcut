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
	title: "Terms of Service - OpenCut",
	description:
		"OpenCut's Terms of Service. Fair, transparent terms for our free and open-source video editor.",
	openGraph: {
		title: "Terms of Service - OpenCut",
		description:
			"OpenCut's Terms of Service. Fair, transparent terms for our free and open-source video editor.",
		type: "website",
	},
};

export async function generateMetadata(): Promise<Metadata> {
	const { t } = await getServerI18n();
	return {
		...metadata,
		title: t("site.pageTitle", { title: t("terms.title") }),
		description: t("terms.description"),
	};
}

export default async function TermsPage() {
	const { t } = await getServerI18n();
	return (
		<BasePage
			title={t("terms.title")}
			description={t("terms.description")}
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
							{t("terms.ownership")}
						</h3>
						<ol className="list-decimal space-y-2 pl-6">
							<li>
								{t("terms.local")}
							</li>
							<li>
								{t("terms.ownershipClaim")}
							</li>
							<li>
								{t("terms.usage")}
							</li>
							<li>
								{t("terms.law")}
							</li>
							<li>
								{t("terms.asIs")}
							</li>
							<li>
								{t("terms.openSource")}
							</li>
							<li>
								{t("terms.noAccount")}
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
				<h2 className="text-2xl font-semibold">{t("terms.contentHeading")}</h2>
				<p>
					<strong>{t("terms.contentOwnership")}</strong> {t("terms.contentPrivacy")}
				</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>
						{t("terms.contentStays")}
					</li>
					<li>{t("terms.ipRights")}</li>
					<li>{t("terms.exports")}</li>
					<li>{t("terms.watermarks")}</li>
				</ul>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("terms.useHeading")}</h2>
				<p>{t("terms.useIntro")}</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>
						{t("terms.personal")}
					</li>
					<li>{t("terms.client")}</li>
					<li>{t("terms.share")}</li>
					<li>
						{t("terms.modify")}
					</li>
				</ul>
				<p>
					{t("terms.legalUse")}
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("terms.featuresHeading")}</h2>
				<p>
					{t("terms.features")}
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("terms.serviceHeading")}</h2>
				<p>
					{t("terms.service")}
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("terms.sourceHeading")}</h2>
				<p>{t("terms.sourceIntro")}</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>{t("terms.review")}</li>
					<li>{t("terms.selfHost")}</li>
					<li>{t("terms.customize")}</li>
					<li>{t("terms.contribute")}</li>
				</ul>
				<p>
					{t("terms.license")}{" "}
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
				<h2 className="text-2xl font-semibold">{t("terms.liabilityHeading")}</h2>
				<p>
					{t("terms.liability")}
				</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>{t("terms.loss")}</li>
					<li>
						{t("terms.browserData")}
					</li>
					<li>{t("terms.responsibility")}</li>
					<li>{t("terms.limit")}</li>
				</ul>
				<p>
					{t("terms.recovery")}
				</p>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("terms.changesHeading")}</h2>
				<p>{t("terms.changes")}</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>{t("terms.notice")}</li>
					<li>{t("terms.acceptance")}</li>
					<li>{t("terms.older")}</li>
					<li>{t("terms.community")}</li>
				</ul>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("terms.stopHeading")}</h2>
				<p>{t("terms.stop")}</p>
				<ul className="list-disc space-y-2 pl-6">
					<li>{t("terms.clear")}</li>
				</ul>
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="text-2xl font-semibold">{t("privacy.contactHeading")}</h2>
				<p>{t("terms.questions")}</p>
				<p>
					{t("terms.contact")}{" "}
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
				<p>
					{t("terms.disputes")}
				</p>
			</section>
			<Separator />
			<p className="text-muted-foreground text-sm">
				{t("privacy.date")}
			</p>
		</BasePage>
	);
}
