import React from 'react';
import { observer } from 'mobx-react-lite';
import { EditorEngine } from '../../stores/EditorEngine';
import { ChevronLeft, ChevronRight, Play, Pause, RotateCcw, Smartphone, Monitor, Tablet } from 'lucide-react';

interface TopBarProps {
  editorEngine: EditorEngine;
}

export const TopBar: React.FC<TopBarProps> = observer(({ editorEngine }) => {
  return (
    <div className="h-12 bg-[#1e1e1e] border-b border-[#333] flex items-center px-4 justify-between">
      {/* Left: Navigation */}
      <div className="flex items-center gap-2">
        <button className="p-1.5 rounded hover:bg-[#333] text-gray-400">
          <ChevronLeft size={16} />
        </button>
        <button className="p-1.5 rounded hover:bg-[#333] text-gray-400">
          <ChevronRight size={16} />
        </button>
        <div className="h-4 w-px bg-[#333] mx-2" />
        <span className="text-sm text-gray-300">Project Name</span>
      </div>

      {/* Center: Device toggles */}
      <div className="flex items-center gap-1 bg-[#252525] rounded-lg p-1">
        <button className="p-1.5 rounded hover:bg-[#333] text-blue-400">
          <Monitor size={14} />
        </button>
        <button className="p-1.5 rounded hover:bg-[#333] text-gray-400">
          <Tablet size={14} />
        </button>
        <button className="p-1.5 rounded hover:bg-[#333] text-gray-400">
          <Smartphone size={14} />
        </button>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs">
          <Play size={12} />
          Preview
        </button>
        <button className="p-1.5 rounded hover:bg-[#333] text-gray-400">
          <Pause size={14} />
        </button>
        <button className="p-1.5 rounded hover:bg-[#333] text-gray-400">
          <RotateCcw size={14} />
        </button>
      </div>
    </div>
  );
});
