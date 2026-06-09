import React from 'react';
import { observer } from 'mobx-react-lite';
import { EditorEngine } from '../../stores/EditorEngine';
import { Layers, Component, Image, Settings } from 'lucide-react';

interface LeftPanelProps {
  editorEngine: EditorEngine;
}

export const LeftPanel: React.FC<LeftPanelProps> = observer(({ editorEngine }) => {
  const [activeTab, setActiveTab] = React.useState('layers');

  const tabs = [
    { id: 'layers', icon: Layers, label: 'Layers' },
    { id: 'components', icon: Component, label: 'Components' },
    { id: 'images', icon: Image, label: 'Images' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ];

  return (
    <div className="w-64 h-full bg-[#1e1e1e] border-r border-[#333] flex flex-col">
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
        {activeTab === 'layers' && (
          <div className="text-sm text-gray-400">
            <p className="mb-2">Page Structure</p>
            <div className="space-y-1">
              <div className="p-2 rounded bg-[#252525] text-xs">{'<html>'}</div>
              <div className="p-2 rounded bg-[#252525] text-xs pl-4">{'<body>'}</div>
              <div className="p-2 rounded bg-[#252525] text-xs pl-8">{'<div id="root">'}</div>
              <div className="p-2 rounded bg-[#2a2a2a] text-xs pl-12 text-blue-400 border-l-2 border-blue-400">
                {'<App />'}
              </div>
            </div>
          </div>
        )}
        {activeTab === 'components' && (
          <div className="text-sm text-gray-400">
            <p>Components library (FASE 2)</p>
          </div>
        )}
        {activeTab === 'images' && (
          <div className="text-sm text-gray-400">
            <p>Image assets (FASE 2)</p>
          </div>
        )}
        {activeTab === 'settings' && (
          <div className="text-sm text-gray-400">
            <p>Project settings (FASE 2)</p>
          </div>
        )}
      </div>
    </div>
  );
});
