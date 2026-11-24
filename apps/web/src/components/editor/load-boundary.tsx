"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EditorCore } from "@/core";
import { getBrowserTranslator } from "@/i18n/browser";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class LoadBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, _errorInfo: ErrorInfo) {
		console.error(error);
	}

	handleReload = () => {
		void EditorCore.getInstance().project.saveCurrentProject().finally(() => location.reload());
	};

	render() {
		if (!this.state.error) return this.props.children;
		const t = getBrowserTranslator();
		return (
			<div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm">
				<p>{t("editor.loadBoundaryMessage")}</p>
				<Button type="button" variant="secondary" onClick={this.handleReload}>
					{t("editor.reload")}
				</Button>
			</div>
		);
	}
}
