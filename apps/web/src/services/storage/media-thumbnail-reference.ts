const referencePattern = /^\/api\/storage\/projects\/([\w-]{1,128})\/media\/([\w-]{1,128})\/thumbnail\/([a-f0-9]{64})$/;

export function parseMediaThumbnailReference(url: unknown) {
	const match = typeof url === "string" && referencePattern.exec(url);
	return match ? { projectId: match[1], mediaId: match[2] } : null;
}
