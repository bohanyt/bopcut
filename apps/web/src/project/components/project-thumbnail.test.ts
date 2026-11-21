import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectThumbnail } from "./project-thumbnail";

test("project thumbnails use the storage URL on initial load and after a refresh", () => {
	const path = "/api/storage/projects/example/thumbnail";
	for (const src of [path, `${path}?v=latest`]) {
		const markup = renderToStaticMarkup(createElement(ProjectThumbnail, { src }));
		expect(markup).toContain(`src="${src}"`);
		expect(markup).not.toContain("/_next/image");
	}
});
