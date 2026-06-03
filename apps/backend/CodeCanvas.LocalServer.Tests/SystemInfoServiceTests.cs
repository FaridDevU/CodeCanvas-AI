using CodeCanvas.LocalServer.Services;

namespace CodeCanvas.LocalServer.Tests;

public class SystemInfoServiceTests
{
    // Fixed clock so UtcTime is deterministic.
    private sealed class StubTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    [Fact]
    public void GetPing_returns_ok_status()
    {
        var service = new SystemInfoService(TimeProvider.System);

        var result = service.GetPing();

        Assert.Equal("ok", result.Status);
    }

    [Fact]
    public void GetPing_returns_service_name()
    {
        var service = new SystemInfoService(TimeProvider.System);

        var result = service.GetPing();

        Assert.Equal("CodeCanvas.LocalServer", result.Service);
    }

    [Fact]
    public void GetPing_returns_non_empty_version()
    {
        var service = new SystemInfoService(TimeProvider.System);

        var result = service.GetPing();

        Assert.False(string.IsNullOrWhiteSpace(result.Version));
    }

    [Fact]
    public void GetPing_uses_the_time_provider()
    {
        var fixedTime = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
        var service = new SystemInfoService(new StubTimeProvider(fixedTime));

        var result = service.GetPing();

        Assert.Equal(fixedTime, result.UtcTime);
    }
}
