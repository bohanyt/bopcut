import { beforeEach, expect, test } from "bun:test";
import { useProjectsStore } from "./store";

const allProjectIds = ["a", "b", "c"];

function resetSelection() {
	useProjectsStore.setState({
		selectedProjectIds: [],
		lastSelectedProjectId: null,
	});
}

beforeEach(() => {
	resetSelection();
});

test("deselecting the anchor prevents shift-click from reselecting it", () => {
	const store = useProjectsStore.getState();
	store.setProjectSelected({ projectId: "a", isSelected: true });
	store.setProjectSelected({ projectId: "a", isSelected: false });
	useProjectsStore
		.getState()
		.selectProjectRange({ projectId: "c", allProjectIds });

	const { selectedProjectIds } = useProjectsStore.getState();
	expect(selectedProjectIds).toEqual(["c"]);
});

test("removing a selected project updates selection and anchor", () => {
	const store = useProjectsStore.getState();
	store.setProjectSelected({ projectId: "a", isSelected: true });
	store.setProjectSelected({ projectId: "b", isSelected: true });
	useProjectsStore.getState().removeProjectFromSelection({ projectId: "b" });

	const { selectedProjectIds, lastSelectedProjectId } =
		useProjectsStore.getState();
	expect(selectedProjectIds).toEqual(["a"]);
	expect(lastSelectedProjectId).not.toBe("b");
});

test("removing an unselected project id changes nothing", () => {
	const store = useProjectsStore.getState();
	store.setProjectSelected({ projectId: "a", isSelected: true });
	const before = useProjectsStore.getState();
	useProjectsStore.getState().removeProjectFromSelection({ projectId: "z" });
	const after = useProjectsStore.getState();

	expect(after.selectedProjectIds).toEqual(before.selectedProjectIds);
	expect(after.lastSelectedProjectId).toBe(before.lastSelectedProjectId);
});