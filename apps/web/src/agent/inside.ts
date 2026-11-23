import { promises as fs } from "node:fs";
import path from "node:path";

export const transcriptCacheParts = ["cache", "transcripts"] as const;

export async function agentAssetPath(filesRoot: string, workspace: string, rel: string) {
	const full = path.resolve(filesRoot, rel);
	if (!full.startsWith(filesRoot + path.sep)) throw new Error("Path outside AGENT_FILES_ROOT");
	const [file, realWorkspace] = await Promise.all([
		fs.realpath(full),
		fs.realpath(workspace).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return workspace;
		}),
	]);
	const location = path.relative(path.join(realWorkspace, ...transcriptCacheParts), file);
	if (location !== ".." && !location.startsWith(".." + path.sep) && !path.isAbsolute(location)) {
		throw new Error("Not found");
	}
	return { file, ext: path.extname(full).toLowerCase() };
}

/**
 * The real path of a regular file under `root`, or null when either is missing. A link that leads out
 * of the root, or anything that is not a regular file, is refused, so these reads stay in their folder.
 */
export async function fileInside(root: string, ...parts: string[]): Promise<string | null> {
	try {
		const base = await fs.realpath(root);
		const file = await fs.realpath(path.join(base, ...parts));
		const relative = path.relative(base, file);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await fs.stat(file)).isFile()) {
			throw new Error("not a file inside its folder");
		}
		return file;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}
