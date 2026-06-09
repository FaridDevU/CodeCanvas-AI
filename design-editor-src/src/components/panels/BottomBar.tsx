import React from 'react';
import { observer } from 'mobx-react-lite';
import { EditorEngine } from '../../stores/EditorEngine';
import { ZoomIn, ZoomOut, Maximize, MessageSquare, GitBranch } from 'lucide-react';

interface BottomBarProps {
  editorEngine: EditorEngine;
}

export const BottomBar: React.FC<BottomBarProps> = observer(({ editorEngine }) => {
  return (
    <div className="h-8 bg-[#1e1e1e] border-t border-[#333] flex items-center px-4 justify-between text-xs text-gray-400">
      {/* Left: Zoom */}
      <div className="flex items-center gap-2">
        <button className="p-1 rounded hover:bg-[#333]">
          <ZoomOut size={12} />
        </button>
        <span>{Math.round(editorEngine.canvas.scale * 100)}%</span>
        <button className="p-1 rounded hover:bg-[#333]">
          <ZoomIn size={12} />
        </button>
        <button className="p-1 rounded hover:bg-[#333]">
          <Maximize size={12} />
        </button>
      </div>

      {/* Center: Status */}
      <div className="flex items-center gap-4">
        <span>Ready</span>
        <span className="text-gray-600">|</span>
        <span>localhost:5173</span>
      </div>

      {/* Right: Tools */}
      <div className="flex items-center gap-2">
        <button className="p-1 rounded hover:bg-[#333] flex items-center gap-1">
          <GitBranch size={12} />
          <span>main</span>
        </button>
        <button className="p-1 rounded hover:bg-[#333] flex items-center gap-1">
          <MessageSquare size={12} />
          <span>Chat</span>
        </button>
      </div>
    </div>
  );
});
