namespace CodeCanvas.LocalServer.Models;

// Health response: confirms the local backend is reachable. No sensitive data.
public sealed record PingResponse
{
    public required string Status { get; init; }
    public required string Service { get; init; }
    public required string Version { get; init; }
    public required DateTimeOffset UtcTime { get; init; }
}
