import { createContext, useContext } from 'react';

// Mock EditorEngine context
const EditorContext = createContext<any>(null);

export function useEditorEngine() {
  return useContext(EditorContext) || {};
}

export function EditorProvider({ children, value }: any) {
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

// Mock types
export type EditorEngine = any;
export type FrameData = any;
export type PreloadScriptState = any;
