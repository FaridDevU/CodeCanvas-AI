import React from 'react';
import { observer } from 'mobx-react-lite';
import { EditorEngine } from '../stores/EditorEngine';

interface CanvasProps {
  editorEngine: EditorEngine;
}

export const Canvas: React.FC<CanvasProps> = observer(({ editorEngine }) => {
  return (
    <div className="relative w-full h-full bg-[#2a2a2a] overflow-hidden flex items-center justify-center">
      {/* Canvas background grid */}
      <div 
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />
      
      {/* Frame / Preview area */}
      <div className="relative bg-white rounded-lg shadow-2xl overflow-hidden" style={{ width: 1024, height: 768, maxWidth: '90%', maxHeight: '90%' }}>
        {/* Iframe for preview */}
        <iframe
          id="design-preview-frame"
          src="http://localhost:5173"
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms"
          title="Design Preview"
        />
        
        {/* Overlay will be rendered here in FASE 2 */}
      </div>
      
      {/* Zoom controls */}
      <div className="absolute bottom-4 left-4 flex items-center gap-2 bg-[#1e1e1e] rounded-lg px-3 py-2 text-sm">
        <button className="hover:text-blue-400">-</button>
        <span>{Math.round(editorEngine.canvas.scale * 100)}%</span>
        <button className="hover:text-blue-400">+</button>
      </div>
    </div>
  );
});
