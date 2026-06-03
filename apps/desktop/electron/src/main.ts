import { app, BrowserWindow } from 'electron';
import { startBackend, stopBackend } from './backend-process';
import { createMainWindow } from './window-manager';

app.whenReady().then(() => {
  startBackend();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', stopBackend);
