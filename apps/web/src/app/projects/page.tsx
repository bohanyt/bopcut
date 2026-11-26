import { redirect } from "next/navigation";

// The projects are on the home page now; old links and bookmarks land there.
export default function ProjectsPage() {
	redirect("/");
}
