using CodeCanvas.LocalServer.Models;

namespace CodeCanvas.LocalServer.Services;

public interface ISystemInfoService
{
    PingResponse GetPing();
}
