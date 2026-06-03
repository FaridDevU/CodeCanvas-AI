import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { PingResponse } from '../models/ping-response';

// Dev backend URL. In packaging this will come from config (see PENDIENTES).
const BACKEND_BASE_URL = 'http://localhost:5064';

@Injectable({ providedIn: 'root' })
export class BackendStatusService {
  private readonly http = inject(HttpClient);

  getPing(): Observable<PingResponse> {
    return this.http.get<PingResponse>(`${BACKEND_BASE_URL}/api/ping`);
  }
}
