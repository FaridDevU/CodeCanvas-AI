param(
	[string[]]$CodeCanvasArgs = @(".")
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$exePath = Join-Path $repoRoot ".build\electron\CodeCanvas AI.exe"

if (-not (Test-Path -LiteralPath $exePath)) {
	Write-Error "No existe '$exePath'. Ejecuta primero: node build\lib\preLaunch.ts"
}

$env:VSCODE_DEV = "1"

Start-Process -FilePath $exePath -ArgumentList (@("--no-sandbox") + $CodeCanvasArgs) -WorkingDirectory $repoRoot
