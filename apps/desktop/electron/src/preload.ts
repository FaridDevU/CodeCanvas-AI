import { contextBridge } from 'electron';

// Minimal, safe bridge. Grows as the app needs native capabilities.
contextBridge.exposeInMainWorld('codecanvas', {
  platform: process.platform,
});
