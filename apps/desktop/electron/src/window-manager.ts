import { BrowserWindow, app } from 'electron';
import * as path from 'node:path';

const ANGULAR_DEV_URL = 'http://localhost:4200';

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#171717',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    const index = path.join(__dirname, '../../angular/dist/codecanvas-ui/browser/index.html');
    window.loadFile(index);
  } else {
    window.loadURL(ANGULAR_DEV_URL);
  }

  return window;
}
