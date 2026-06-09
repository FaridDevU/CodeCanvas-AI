import React from 'react';
import { observer } from 'mobx-react-lite';
import { EditorEngine } from '../../stores/EditorEngine';
import { Type, Palette, Layout, MousePointer } from 'lucide-react';

interface RightPanelProps {
  editorEngine: EditorEngine;
}

export const RightPanel: React.FC<RightPanelProps> = observer(({ editorEngine }) => {
  const [activeTab, setActiveTab] = React.useState('properties');

  const tabs = [
    { id: 'properties', icon: MousePointer, label: 'Properties' },
    { id: 'styles', icon: Palette, label: 'Styles' },
    { id: 'layout', icon: Layout, label: 'Layout' },
    { id: 'typography', icon: Type, label: 'Text' },
  ];

  return (
    <div className="w-72 h-full bg-[#1e1e1e] border-l border-[#333] flex flex-col">
      {/* Tabs */}
      <div className="flex border-b border-[#333]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 p-3 flex flex-col items-center gap-1 text-xs transition-colors ${
              activeTab === tab.id ? 'text-blue-400 bg-[#252525]' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            <tab.icon size={16} />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-auto">
        {activeTab === 'properties' && (
          <div className="space-y-4">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Tag</label>
              <div className="text-sm text-white">{'<div>'}</div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Class</label>
              <div className="text-sm text-white">container flex items-center</div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">ID</label>
              <div className="text-sm text-white">-</div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Dimensions</label>
              <div className="text-sm text-white">1024 × 768</div>
            </div>
          </div>
        )}
        {activeTab === 'styles' && (
          <div className="text-sm text-gray-400">
            <p>Style properties (FASE 2)</p>
          </div>
        )}
        {activeTab === 'layout' && (
          <div className="text-sm text-gray-400">
            <p>Layout properties (FASE 2)</p>
          </div>
        )}
        {activeTab === 'typography' && (
          <div className="text-sm text-gray-400">
            <p>Typography properties (FASE 2)</p>
          </div>
        )}
      </div>
    </div>
  );
});
