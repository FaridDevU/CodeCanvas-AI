using System.Net;
using System.Net.Http.Json;
using CodeCanvas.LocalServer.Models;
using Microsoft.AspNetCore.Mvc.Testing;

namespace CodeCanvas.LocalServer.Tests;

public class PingEndpointTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly WebApplicationFactory<Program> _factory;

    public PingEndpointTests(WebApplicationFactory<Program> factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task GET_api_ping_returns_200()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/ping");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GET_api_ping_returns_ok_payload()
    {
        var client = _factory.CreateClient();

        var body = await client.GetFromJsonAsync<PingResponse>("/api/ping");

        Assert.NotNull(body);
        Assert.Equal("ok", body!.Status);
        Assert.Equal("CodeCanvas.LocalServer", body.Service);
    }

    [Fact]
    public async Task GET_unknown_route_returns_404()
    {
        var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/does-not-exist");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
