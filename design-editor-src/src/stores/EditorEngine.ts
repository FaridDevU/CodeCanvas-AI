import { makeAutoObservable } from 'mobx';

// Mock EditorEngine for FASE 1
// This replaces the full Onlook EditorEngine with minimal stubs
// so the UI components can render without backend dependencies

export class EditorEngine {
  canvas = {
    scale: 1,
    position: { x: 0, y: 0 },
    frames: [] as any[],
    isDragging: false,
  };

  overlay = {
    hoveredElement: null as any,
    selectedElement: null as any,
    isResizing: false,
  };

  style = {
    selectedStyles: {} as Record<string, string>,
  };

  history = {
    canUndo: false,
    canRedo: false,
  };

  constructor() {
    makeAutoObservable(this);
  }

  // Mock methods for FASE 1
  setHoveredElement(element: any) {
    this.overlay.hoveredElement = element;
  }

  setSelectedElement(element: any) {
    this.overlay.selectedElement = element;
  }

  clearSelection() {
    this.overlay.selectedElement = null;
    this.overlay.hoveredElement = null;
  }
}
