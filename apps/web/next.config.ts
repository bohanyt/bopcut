import type { NextConfig } from "next";
import { withContentCollections } from "@content-collections/next";
import path from "node:path";

const standalone = process.env.BOPENCUT_STANDALONE === "1";
const repositoryRoot = path.resolve(__dirname, "../..");

const nextConfig: NextConfig = {
	devIndicators: false,
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	...(standalone && {
		output: "standalone",
		outputFileTracingRoot: repositoryRoot,
		turbopack: { root: repositoryRoot },
	}),
	serverExternalPackages: ["@napi-rs/canvas"],
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.marblecms.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
};

export default withContentCollections(nextConfig);
