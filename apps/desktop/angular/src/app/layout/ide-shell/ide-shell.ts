import { Component, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFolderTree,
  lucideCode,
  lucideMonitor,
  lucideTerminal,
  lucideSettings,
  lucideBot,
} from '@ng-icons/lucide';

type Pane = 'left' | 'right' | 'bottom';

@Component({
  selector: 'app-ide-shell',
  imports: [NgIcon],
  viewProviders: [
    provideIcons({
      lucideFolderTree,
      lucideCode,
      lucideMonitor,
      lucideTerminal,
      lucideSettings,
      lucideBot,
    }),
  ],
  templateUrl: './ide-shell.html',
})
export class IdeShell {
  readonly leftWidth = signal(260);
  readonly rightWidth = signal(320);
  readonly bottomHeight = signal(200);

  private active: Pane | null = null;
  private startPos = 0;
  private startSize = 0;

  startResize(pane: Pane, event: PointerEvent): void {
    this.active = pane;
    this.startPos = pane === 'bottom' ? event.clientY : event.clientX;
    this.startSize =
      pane === 'left'
        ? this.leftWidth()
        : pane === 'right'
          ? this.rightWidth()
          : this.bottomHeight();
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    event.preventDefault();
  }

  private onMove = (event: PointerEvent): void => {
    if (!this.active) {
      return;
    }
    if (this.active === 'left') {
      this.leftWidth.set(this.clamp(this.startSize + (event.clientX - this.startPos), 180, 480));
    } else if (this.active === 'right') {
      this.rightWidth.set(this.clamp(this.startSize + (this.startPos - event.clientX), 220, 520));
    } else {
      this.bottomHeight.set(this.clamp(this.startSize + (this.startPos - event.clientY), 120, 480));
    }
  };

  private onUp = (): void => {
    this.active = null;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
  };

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
