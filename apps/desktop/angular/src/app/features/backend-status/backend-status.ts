import { Component, inject, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlug, lucideLoaderCircle, lucideCircleCheck, lucideCircleX } from '@ng-icons/lucide';
import { BackendStatusService } from '../../core/api/backend-status.service';
import { PingResponse } from '../../core/models/ping-response';

type Status = 'idle' | 'loading' | 'ok' | 'error';

@Component({
  selector: 'app-backend-status',
  imports: [NgIcon],
  viewProviders: [
    provideIcons({ lucidePlug, lucideLoaderCircle, lucideCircleCheck, lucideCircleX }),
  ],
  templateUrl: './backend-status.html',
})
export class BackendStatus {
  private readonly service = inject(BackendStatusService);

  readonly status = signal<Status>('idle');
  readonly result = signal<PingResponse | null>(null);
  readonly error = signal<string | null>(null);

  check(): void {
    this.status.set('loading');
    this.error.set(null);
    this.service.getPing().subscribe({
      next: (res) => {
        this.result.set(res);
        this.status.set('ok');
      },
      error: (err: unknown) => {
        this.error.set(err instanceof Error ? err.message : 'No se pudo contactar al backend');
        this.status.set('error');
      },
    });
  }
}
