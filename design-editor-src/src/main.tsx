import React from 'react';
import ReactDOM from 'react-dom/client';
import '@onlook/ui/globals.css';
import { DesignApp } from './DesignApp';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <DesignApp />
  </React.StrictMode>
);
