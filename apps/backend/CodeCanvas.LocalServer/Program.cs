using CodeCanvas.LocalServer.Services;

var builder = WebApplication.CreateBuilder(args);

// CORS so the Angular dev server (localhost:4200) can reach the local backend.
const string DevCorsPolicy = "codecanvas-dev";
builder.Services.AddCors(options =>
{
    options.AddPolicy(DevCorsPolicy, policy =>
        policy.WithOrigins("http://localhost:4200", "http://127.0.0.1:4200")
              .AllowAnyHeader()
              .AllowAnyMethod());
});

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<ISystemInfoService, SystemInfoService>();
builder.Services.AddControllers();
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.UseCors(DevCorsPolicy);
}

app.MapControllers();

app.Run();

// Exposed for integration tests (WebApplicationFactory).
public partial class Program;
