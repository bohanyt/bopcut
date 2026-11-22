import { ThemeProvider } from "next-themes";
import { cookies, headers } from "next/headers";
import { LocaleProvider } from "@/i18n/provider";
import { LOCALE_COOKIE, resolveLocale } from "@/i18n/locale";
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
	const [cookieStore, requestHeaders] = await Promise.all([cookies(), headers()]);
	const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, requestHeaders.get("accept-language"));

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
