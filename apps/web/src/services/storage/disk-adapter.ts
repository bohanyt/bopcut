import { toast } from "sonner";
import type { SerializedProject, MediaAssetData, ProjectNavigation, ProjectSummary } from "./types";

const base = "/api/storage/projects";
const projectUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;
async function checked(response: Response): Promise<Response> {
	if (!response.ok)
		throw new Error(
			`Storage failed (${response.status}): ${await response.text()}`,
		);
	return response;
}

export class DiskAdapter {
	private revisions = new Map<string, string>();
	private writes = new Map<string, Promise<void>>();
	/**
	 * Projects this adapter saw exist and then saw gone (deleted here or in another tab): a write never
	 * creates them again. Ids are never reused, so a new project is never in here.
	 */
	private gone = new Set<string>();
	async get(id: string): Promise<SerializedProject | null> {
		return (await this.read(id))?.value ?? null;
	}
	/** Reads a project with the revision of that copy (the shared cache can move on meanwhile). */
	private async read(id: string): Promise<{ value: SerializedProject; revision: string } | null> {
		const response = await fetch(projectUrl(id), { cache: "no-store" });
		if (response.status === 404) {
			if (this.revisions.has(id)) this.gone.add(id);
			this.revisions.delete(id);
			return null;
		}
		await checked(response);
		const revision = response.headers.get("etag") ?? "new";
		this.revisions.set(id, revision);
		return { value: await response.json(), revision };
	}
	async summaries(): Promise<ProjectSummary[]> {
		return (await checked(await fetch(base, { cache: "no-store" }))).json();
	}
	async list(): Promise<string[]> {
		return (await this.summaries()).map((project) => project.metadata.id);
	}
	async saveNavigation(id: string, value: ProjectNavigation): Promise<void> {
		await this.queued(id, async () => {
			await checked(await fetch(`${projectUrl(id)}/navigation`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(value),
			}));
		});
	}
	async saveThumbnail(id: string, thumbnail: Blob): Promise<string> {
		const url = `${projectUrl(id)}/thumbnail`;
		const response = await checked(await fetch(url, {
			method: "PUT", body: thumbnail, signal: AbortSignal.timeout(10_000),
		}));
		const etag = response.headers.get("etag");
		return etag ? `${url}?v=${encodeURIComponent(etag)}` : url;
	}
	async set({
		key,
		value,
	}: {
		key: string;
		value: SerializedProject;
	}): Promise<void> {
		await this.queued(key, () => this.writeProject(key, value));
	}
	/**
	 * Changes the stored project with `change`, applied to the copy on disk at the moment of the write:
	 * if another write lands in between, it is read again and changed again (never overwritten). Null
	 * when the project does not exist.
	 */
	async update(
		key: string,
		change: (value: SerializedProject) => SerializedProject | Promise<SerializedProject>,
	): Promise<SerializedProject | null> {
		let result: SerializedProject | null = null;
		await this.queued(key, async () => {
			for (let attempt = 0; attempt < 5; attempt++) {
				const current = await this.read(key);
				if (!current) return;
				const next = await change(current.value);
				if (next === current.value) {
					result = current.value;
					return;
				}
				// The revision of the copy that was changed, not the shared cache: another read may have moved
				// that on (to a newer copy, or to "gone"), and the write must not pass on its strength.
				const response = await fetch(projectUrl(key), {
					method: "PUT",
					headers: { "Content-Type": "application/json", "If-Match": current.revision },
					body: JSON.stringify(next),
				});
				if (response.status === 409) continue;
				await checked(response);
				this.revisions.set(key, response.headers.get("etag") ?? "new");
				result = next;
				return;
			}
			throw new Error("The project kept changing; try again");
		});
		return result;
	}
	/** Writes of one project run one after another, in call order. */
	private async queued(key: string, run: () => Promise<void>): Promise<void> {
		const previous = this.writes.get(key) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(run);
		this.writes.set(key, current);
		try {
			await current;
		} finally {
			if (this.writes.get(key) === current) this.writes.delete(key);
		}
	}
	private async writeProject(
		key: string,
		value: SerializedProject,
	): Promise<void> {
		if (this.gone.has(key)) throw new Error("The project was deleted; not saved");
		let expected = this.revisions.get(key);
		if (!expected) {
			await this.get(key);
			expected = this.revisions.get(key) ?? "new";
		}
		const write = (version: string) =>
			fetch(projectUrl(key), {
				method: "PUT",
				headers: { "Content-Type": "application/json", "If-Match": version },
				body: JSON.stringify(value),
			});
		let response = await write(expected);
		if (response.status === 409) {
			toast.warning(
				"The project was also changed in another browser; the latest save will overwrite those changes.",
			);
			for (let attempt = 0; attempt < 3 && response.status === 409; attempt++) {
				// Deleted meanwhile: a write must not bring it back.
				if (!(await this.get(key))) throw new Error("The project was deleted; not saved");
				response = await write(this.revisions.get(key) ?? "new");
			}
		}
		await checked(response);
		this.revisions.set(key, response.headers.get("etag") ?? "new");
	}
	async migrate(value: SerializedProject): Promise<boolean> {
		const response = await checked(
			await fetch(projectUrl(value.metadata.id), {
				method: "PUT",
				headers: { "Content-Type": "application/json", "X-Migration": "1" },
				body: JSON.stringify(value),
			}),
		);
		return !(await response.json()).skipped;
	}
	async migrationExists(id: string): Promise<boolean> {
		return (
			await (
				await checked(
					await fetch(`${projectUrl(id)}/migration`, { cache: "no-store" }),
				)
			).json()
		).exists;
	}
	async remove(id: string): Promise<void> {
		await checked(await fetch(projectUrl(id), { method: "DELETE" }));
		this.revisions.delete(id);
		this.gone.add(id);
	}
	async clear(): Promise<void> {
		for (const id of await this.list()) await this.remove(id);
	}
	async mediaList(id: string): Promise<MediaAssetData[]> {
		return (
			await checked(
				await fetch(`${projectUrl(id)}/media`, { cache: "no-store" }),
			)
		).json();
	}
	mediaUrl(id: string, mediaId: string): string {
		return `${projectUrl(id)}/media/${encodeURIComponent(mediaId)}`;
	}
	async hasStoredMediaAsset(id: string, mediaId: string, signal: AbortSignal): Promise<boolean> {
		const response = await fetch(this.mediaUrl(id, mediaId), { method: "HEAD", cache: "no-store", signal });
		if (response.status === 404) return false;
		await checked(response);
		return true;
	}
	async saveMedia(
		id: string,
		metadata: MediaAssetData,
		file: File,
	): Promise<void> {
		const url = this.mediaUrl(id, metadata.id);
		const minimal = {
			id: metadata.id,
			fileName: metadata.fileName,
			fileType: metadata.fileType,
		};
		await checked(
			await fetch(url, {
				method: "PUT",
				headers: {
					"X-Media-Metadata": encodeURIComponent(JSON.stringify(minimal)),
				},
				body: file,
			}),
		);
		await checked(
			await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(metadata),
			}),
		);
	}
	/** Replaces the metadata of stored media (its file stays). */
	async updateMediaMetadata(id: string, metadata: MediaAssetData): Promise<void> {
		await checked(
			await fetch(this.mediaUrl(id, metadata.id), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(metadata),
			}),
		);
	}
	async removeMedia(id: string, mediaId: string): Promise<void> {
		await checked(
			await fetch(this.mediaUrl(id, mediaId), { method: "DELETE" }),
		);
	}
	async removeProjectMedia(id: string): Promise<void> {
		await checked(await fetch(`${projectUrl(id)}/media`, { method: "DELETE" }));
	}
}

export class DiskSoundsAdapter<T> {
	async get(_key: string): Promise<T | null> {
		return (
			await checked(await fetch("/api/storage/sounds", { cache: "no-store" }))
		).json();
	}
	async set({ value }: { key: string; value: T }): Promise<void> {
		await checked(
			await fetch("/api/storage/sounds", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(value),
			}),
		);
	}
	async migrate(value: T): Promise<void> {
		await checked(
			await fetch("/api/storage/sounds", {
				method: "PUT",
				headers: { "Content-Type": "application/json", "If-None-Match": "*" },
				body: JSON.stringify(value),
			}),
		);
	}
	async remove(_key: string): Promise<void> {
		await checked(await fetch("/api/storage/sounds", { method: "DELETE" }));
	}
}
