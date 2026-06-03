import { ChildProcess, spawn } from 'node:child_process';
import * as path from 'node:path';
import { app } from 'electron';

export const BACKEND_PORT = 5064;

let backend: ChildProcess | null = null;

export function startBackend(): void {
  if (backend) {
    return;
  }

  const url = `http://localhost:${BACKEND_PORT}`;

  if (app.isPackaged) {
    // Packaging will ship a published self-contained binary (see PENDIENTES).
    const exe = path.join(process.resourcesPath, 'backend', 'CodeCanvas.LocalServer.exe');
    backend = spawn(exe, ['--urls', url], { stdio: 'inherit' });
    return;
  }

  // Dev: run the project through the dotnet CLI.
  const projectPath = path.resolve(__dirname, '../../../backend/CodeCanvas.LocalServer');
  backend = spawn('dotnet', ['run', '--project', projectPath, '--urls', url], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

export function stopBackend(): void {
  backend?.kill();
  backend = null;
}
