// Mirrors the backend PingResponse DTO.
export interface PingResponse {
  status: string;
  service: string;
  version: string;
  utcTime: string;
}
