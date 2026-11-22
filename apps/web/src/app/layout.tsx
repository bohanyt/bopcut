import { ThemeProvider } from "next-themes";
import { getServerI18n } from "@/i18n/server";
import { LocaleProvider } from "@/i18n/provider";
import "./globals.css";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import { BotIdClient } from "botid/client";
import { Inter } from "next/font/google";

const siteFont = Inter({ subsets: ["latin"] });

export const metadata = baseMetaData;

const protectedRoutes = [
	{
		path: "/none",
		method: "GET",
	},
];

export default async function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	const { locale } = await getServerI18n();

	return (
		<html lang={locale} suppressHydrationWarning>
			<head>
				<BotIdClient protect={protectedRoutes} />
			</head>
			<body className={`${siteFont.className} font-sans antialiased`}>
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					disableTransitionOnChange={true}
				>
					<LocaleProvider initialLocale={locale}>
						<TooltipProvider>
							<Toaster />
							{children}
						</TooltipProvider>
					</LocaleProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
