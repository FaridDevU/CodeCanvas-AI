'use client';

import { EditorEngineProvider, useEditorEngine } from '@/components/store/editor';
import { EditorAttributes } from '@onlook/constants';
import { TooltipProvider } from '@onlook/ui/tooltip';
import { observer } from 'mobx-react-lite';
import { Component, useEffect, useRef, type ReactNode } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { BottomBar } from '@/components/bottom-bar';
import { Canvas } from '@/components/canvas';
import { EditorBar } from '@/components/editor-bar';
import { LeftPanel } from '@/components/left-panel';
import { TopBar } from '@/components/top-bar';
import { usePanelMeasurements } from '@/hooks/use-panel-measure';
import { useStartProject } from '@/hooks/use-start-project';
import { useInspectorBridge } from '@/hooks/use-inspector-bridge';
import { ProjectPicker } from '@/components/project-picker';

// Local project/branch bootstrap. Onlook fetched these from the cloud; locally we seed
// a single in-memory project. The folder open in CodeCanvas drives the real files later.
const LOCAL_PROJECT: any = {
	id: 'local',
	name: 'Local Project',
	metadata: { previewImg: null },
};
const LOCAL_BRANCHES: any[] = [
	{
		id: 'local-branch',
		projectId: 'local',
		name: 'main',
		description: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		isDefault: true,
		git: null,
		sandbox: { id: 'local-sandbox' },
	},
];

const EditorLayout = observer(() => {
	const editorEngine = useEditorEngine();
	const { isProjectReady, needsProjectChoice, apps, chooseApp, error } = useStartProject();
	useInspectorBridge();
	const leftPanelRef = useRef<HTMLDivElement | null>(null);
	const rightPanelRef = useRef<HTMLDivElement | null>(null);
	const { toolbarLeft, toolbarRight, editorBarAvailableWidth } = usePanelMeasurements(
		leftPanelRef,
		rightPanelRef,
	);

	useEffect(() => {
		function handleGlobalWheel(event: WheelEvent) {
			if (!(event.ctrlKey || event.metaKey)) {
				return;
			}
			const canvasContainer = document.getElementById(EditorAttributes.CANVAS_CONTAINER_ID);
			if (canvasContainer?.contains(event.target as Node | null)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
		}
		window.addEventListener('wheel', handleGlobalWheel, { passive: false });
		return () => window.removeEventListener('wheel', handleGlobalWheel);
	}, []);

	if (error) {
		return (
			<div className="h-screen w-screen flex flex-col items-center justify-center gap-4 text-white px-8 text-center">
				<p className="text-sm text-foreground-secondary max-w-md">Failed to start the project: {error}</p>
				<button
					onClick={() => window.location.reload()}
					className="rounded-md bg-teal-600 hover:bg-teal-500 text-white text-sm px-4 py-1.5 transition-colors"
				>
					Reintentar
				</button>
			</div>
		);
	}

	if (needsProjectChoice) {
		return <ProjectPicker apps={apps} onChoose={chooseApp} />;
	}

	if (!isProjectReady) {
		return (
			<div className="h-screen w-screen flex items-center justify-center text-white">
				Loading project...
			</div>
		);
	}

	return (
		<TooltipProvider>
			<div className="h-screen w-screen flex flex-row select-none relative overflow-hidden">
				<Canvas />

				{/* z-[3100]: stay above react-moveable's control box (z 3000) so it can't steal clicks. */}
				<div className="absolute top-0 w-full z-[3100]">
					<TopBar />
				</div>

				<div ref={leftPanelRef} className="absolute top-10 left-0 h-[calc(100%-40px)] z-[3100]">
					<LeftPanel />
				</div>

				<div
					className="absolute top-10 z-[3100]"
					style={{
						left: toolbarLeft,
						right: toolbarRight,
						overflow: 'hidden',
						pointerEvents: 'none',
						maxWidth: editorBarAvailableWidth,
						display: 'flex',
						justifyContent: 'center',
						alignItems: 'flex-start',
					}}
				>
					<div style={{ pointerEvents: 'auto' }}>
						<EditorBar availableWidth={editorBarAvailableWidth} />
					</div>
				</div>

				{/* Onlook's AI chat panel removed — CodeCanvas uses GitHub Copilot (outside the
				    iframe). The right panel was entirely the chat, so it is not rendered. */}

				<BottomBar />
			</div>
		</TooltipProvider>
	);
});

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	state = { error: null as Error | null };
	static getDerivedStateFromError(error: Error) {
		return { error };
	}
	componentDidCatch(error: Error, info: any) {
		console.error('[DesignApp render error]', error?.message, error?.stack?.split('\n').slice(0, 6).join(' | '), 'COMPONENT STACK:', String(info?.componentStack).split('\n').slice(0, 8).join(' | '));
	}
	render() {
		if (this.state.error) {
			return (
				<div style={{ color: '#f88', padding: 16, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
					Design editor crashed: {this.state.error.message}
				</div>
			);
		}
		return this.props.children;
	}
}

export const DesignApp = () => {
	return (
		<ErrorBoundary>
			<DndProvider backend={HTML5Backend}>
				<EditorEngineProvider project={LOCAL_PROJECT} branches={LOCAL_BRANCHES}>
					{/* No cloud providers: Design is fully local. Onlook's HostingProvider
					    (publish/deploy via tRPC) was removed; nothing here queries the cloud. */}
					<EditorLayout />
				</EditorEngineProvider>
			</DndProvider>
		</ErrorBoundary>
	);
};
