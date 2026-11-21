import Image from "next/image";

export function ProjectThumbnail({ src }: { src: string }) {
	return (
		<Image
			src={src}
			alt="Project thumbnail"
			fill
			className="object-cover"
			// Disk thumbnails are already sized and revalidated by the storage route.
			unoptimized={/^\/api\/storage\/projects\/[\w-]+\/thumbnail(?:\?|$)/.test(src)}
		/>
	);
}
