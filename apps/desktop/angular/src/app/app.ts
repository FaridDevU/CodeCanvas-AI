import { Component } from '@angular/core';
import { IdeShell } from './layout/ide-shell/ide-shell';

@Component({
  selector: 'app-root',
  imports: [IdeShell],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}
