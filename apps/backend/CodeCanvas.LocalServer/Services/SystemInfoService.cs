using System.Reflection;
using CodeCanvas.LocalServer.Models;

namespace CodeCanvas.LocalServer.Services;

public sealed class SystemInfoService : ISystemInfoService
{
    private readonly TimeProvider _timeProvider;

    public SystemInfoService(TimeProvider timeProvider)
    {
        _timeProvider = timeProvider;
    }

    public PingResponse GetPing()
    {
        // Version comes from the assembly to avoid duplicating it by hand.
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";

        return new PingResponse
        {
            Status = "ok",
            Service = "CodeCanvas.LocalServer",
            Version = version,
            UtcTime = _timeProvider.GetUtcNow(),
        };
    }
}
