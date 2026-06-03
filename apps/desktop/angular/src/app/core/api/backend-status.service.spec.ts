import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BackendStatusService } from './backend-status.service';
import { PingResponse } from '../models/ping-response';

describe('BackendStatusService', () => {
  let service: BackendStatusService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(BackendStatusService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('requests GET /api/ping and returns the payload', () => {
    const expected: PingResponse = {
      status: 'ok',
      service: 'CodeCanvas.LocalServer',
      version: '1.0.0.0',
      utcTime: '2026-01-01T00:00:00+00:00',
    };

    let actual: PingResponse | undefined;
    service.getPing().subscribe((res) => (actual = res));

    const req = httpMock.expectOne('http://localhost:5064/api/ping');
    expect(req.request.method).toBe('GET');
    req.flush(expected);

    expect(actual).toEqual(expected);
  });

  it('propagates an error when the backend is unreachable', () => {
    let errored = false;
    service.getPing().subscribe({
      next: () => {
        throw new Error('should not emit');
      },
      error: () => (errored = true),
    });

    httpMock
      .expectOne('http://localhost:5064/api/ping')
      .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });

    expect(errored).toBe(true);
  });
});
