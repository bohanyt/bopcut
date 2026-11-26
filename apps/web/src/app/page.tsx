import type { Metadata } from "next";
import { HomePage } from "@/home/home-page";
import { SITE_URL } from "@/site/brand";

export const metadata: Metadata = {
	alternates: {
		canonical: SITE_URL,
	},
};

export default function Home() {
	return <HomePage />;
}
