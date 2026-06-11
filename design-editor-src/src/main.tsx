import React from 'react';
import ReactDOM from 'react-dom/client';
import '@onlook/ui/globals.css';
import { DesignApp } from './DesignApp';
import { startVscodeThemeSync } from './lib/vscode-theme';

// Inherit CodeCanvas's active VS Code theme colors (no-op on the standalone dev server).
startVscodeThemeSync();

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <DesignApp />
  </React.StrictMode>
);
