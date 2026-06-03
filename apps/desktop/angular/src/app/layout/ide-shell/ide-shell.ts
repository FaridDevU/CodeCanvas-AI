import { Component, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideFiles,
  lucideSearch,
  lucideGitBranch,
  lucideSettings,
  lucideSquareCode,
  lucideFilePlus,
  lucideFolderPlus,
  lucideRefreshCw,
  lucideX,
  lucideFileCode,
  lucideMousePointerClick,
  lucideTerminal,
  lucidePlus,
  lucideTrash2,
  lucideChevronDown,
} from '@ng-icons/lucide';
import { BackendStatus } from '../../features/backend-status/backend-status';

type Pane = 'left' | 'bottom';
type View = 'explorer' | 'search' | 'git';

interface RailItem {
  id: View;
  icon: string;
  label: string;
}

@Component({
  selector: 'app-ide-shell',
  imports: [NgIcon, BackendStatus],
  viewProviders: [
    provideIcons({
      lucideFiles,
      lucideSearch,
      lucideGitBranch,
      lucideSettings,
      lucideSquareCode,
      lucideFilePlus,
      lucideFolderPlus,
      lucideRefreshCw,
      lucideX,
      lucideFileCode,
      lucideMousePointerClick,
      lucideTerminal,
      lucidePlus,
      lucideTrash2,
      lucideChevronDown,
    }),
  ],
  templateUrl: './ide-shell.html',
})
export class IdeShell {
  readonly railItems: readonly RailItem[] = [
    { id: 'explorer', icon: 'lucideFiles', label: 'Explorador' },
    { id: 'search', icon: 'lucideSearch', label: 'Buscar' },
    { id: 'git', icon: 'lucideGitBranch', label: 'Control de versiones' },
  ];

  readonly activeView = signal<View>('explorer');

  readonly leftWidth = signal(248);
  readonly bottomHeight = signal(200);

  private active: Pane | null = null;
  private startPos = 0;
  private startSize = 0;

  activeLabel(): string {
    return this.railItems.find((item) => item.id === this.activeView())?.label ?? '';
  }

  startResize(pane: Pane, event: PointerEvent): void {
    this.active = pane;
    this.startPos = pane === 'bottom' ? event.clientY : event.clientX;
    this.startSize = pane === 'left' ? this.leftWidth() : this.bottomHeight();
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
