using CodeCanvas.LocalServer.Models;
using CodeCanvas.LocalServer.Services;
using Microsoft.AspNetCore.Mvc;

namespace CodeCanvas.LocalServer.Controllers;

[ApiController]
[Route("api/[controller]")]
[Produces("application/json")]
public sealed class PingController : ControllerBase
{
    private readonly ISystemInfoService _systemInfo;

    public PingController(ISystemInfoService systemInfo)
    {
        _systemInfo = systemInfo;
    }

    [HttpGet]
    [ProducesResponseType<PingResponse>(StatusCodes.Status200OK)]
    public ActionResult<PingResponse> Get() => Ok(_systemInfo.GetPing());
}
