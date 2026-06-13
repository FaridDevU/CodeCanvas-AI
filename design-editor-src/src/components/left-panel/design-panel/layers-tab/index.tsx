import { debugLog } from '@/lib/debug';
import { useEditorEngine } from '@/components/store/editor';
import { Icons } from '@onlook/ui/icons';
import type { LayerNode } from '@onlook/models/element';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type NodeApi, Tree, type TreeApi } from 'react-arborist';
import useResizeObserver from 'use-resize-observer';
import { RightClickMenu } from '../../../right-click-menu';
import { TreeNode } from './tree/tree-node';
import { TreeRow } from './tree/tree-row';

export const LayersTab = observer(() => {
    const treeRef = useRef<TreeApi<LayerNode>>(null);
    const editorEngine = useEditorEngine();
    const [treeHovered, setTreeHovered] = useState(false);
    const { ref, width, height } = useResizeObserver();

    useEffect(handleSelectChange, [
        editorEngine.elements.selected,
        editorEngine.ast.mappings.filteredLayers,
    ]);

    const handleMouseLeaveTree = useCallback(() => {
        setTreeHovered(false);
        editorEngine.overlay.state.updateHoverRect(null);
    }, [editorEngine.overlay.state]);

    function handleSelectChange() {
        if (editorEngine.elements.selected.length > 0 && editorEngine.elements.selected[0]) {
            treeRef.current?.scrollTo(editorEngine.elements.selected[0].domId);
        }
    }

    const handleDragEnd = useCallback(
        async ({
            dragNodes,
            parentNode,
            index,
        }: {
            dragNodes: NodeApi<LayerNode>[];
            parentNode: NodeApi<LayerNode> | null;
            index: number;
        }) => {
            if (!parentNode) {
                console.error('No parent found');
                return;
            }
            if (dragNodes.length !== 1) {
                console.error('Only one element can be dragged at a time');
                return;
            }
            const dragNode = dragNodes[0];
            if (!dragNode) {
                console.error('No drag node found');
                return;
            }
            const frameData = editorEngine.frames.get(dragNode.data.frameId);
            if (!frameData) {
                console.error('No frame data found');
                return;
            }
            const { view } = frameData;

            if (!view) {
                console.error('No frame view found');
                return;
            }

            const originalIndex: number | undefined = await view.getElementIndex(
                dragNode.data.domId,
            );

            if (originalIndex === undefined) {
                console.error('No original index found');
                return;
            }

            const childEl = await view.getElementByDomId(dragNode.data.domId, false);
            if (!childEl) {
                console.error('Failed to get element');
                return;
            }
            const parentEl = await view.getElementByDomId(parentNode.data.domId, false);
            if (!parentEl) {
                console.error('Failed to get parent element');
                return;
            }

            const newIndex = index > originalIndex ? index - 1 : index;

            if (newIndex === originalIndex) {
                console.log('No index change');
                return;
            }

            const moveAction = editorEngine.move.createMoveAction(
                view.id,
                childEl,
                parentEl,
                newIndex,
                originalIndex,
            );
            editorEngine.action.run(moveAction);
        },
        [],
    );

    const disableDrop = useCallback(
        ({
            parentNode,
            dragNodes,
        }: {
            parentNode: NodeApi<LayerNode> | null;
            dragNodes: NodeApi<LayerNode>[];
        }) => {
            return !dragNodes.every((node) => node?.parent?.id === parentNode?.id);
        },
        [],
    );

    const childrenAccessor = useCallback(
        (node: LayerNode) => {
            const children = node.children
                ?.map((child) => editorEngine.ast.mappings.getLayerNode(node.frameId, child))
                .filter((child) => child !== undefined)!;

            return children?.length ? children : null;
        },
        [editorEngine.ast.mappings],
    );

    const layers = editorEngine.ast.mappings.filteredLayers;
    const isEmpty = !layers || layers.length === 0;
    debugLog('[CC-LAYERS] render', { count: layers?.length ?? 0, isEmpty, measuredHeight: height, measuredWidth: width });

    if (isEmpty) {
        // An empty tree used to render a blank 280px panel that just covered the canvas. Show a
        // clear hint instead so it's obvious there's nothing to list (and why).
        return (
            <div
                ref={ref}
                className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-foreground-tertiary"
            >
                <Icons.Layers className="h-5 w-5 opacity-60" />
                <p>No hay capas para mostrar todavía.</p>
                <p className="opacity-70">Selecciona un elemento en el lienzo para verlo aquí.</p>
            </div>
        );
    }

    return (
        <div
            ref={ref}
            className="flex h-full w-full overflow-hidden text-xs text-active p-3"
            onMouseOver={() => setTreeHovered(true)}
            onMouseLeave={handleMouseLeaveTree}
        >
            <RightClickMenu>
                <Tree
                    idAccessor={(node) => node.domId}
                    childrenAccessor={childrenAccessor}
                    ref={treeRef}
                    data={editorEngine.ast.mappings.filteredLayers}
                    openByDefault={true}
                    overscanCount={0}
                    indent={8}
                    padding={0}
                    rowHeight={24}
                    height={height ?? 300}
                    width={width ?? 232}
                    renderRow={(props: any) => <TreeRow {...props} />}
                    onMove={handleDragEnd}
                    disableDrop={disableDrop}
                    className="overflow-auto"
                >
                    {(props) => <TreeNode {...props} treeHovered={treeHovered} />}
                </Tree>
            </RightClickMenu>
        </div>
    );
});
