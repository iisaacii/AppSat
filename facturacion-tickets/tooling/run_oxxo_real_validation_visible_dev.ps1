$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

$env:PORTAL_RUNNER_MODE = "playwright"
$env:PORTAL_USE_FIXTURE = "false"
$env:PORTAL_ARTIFACTS_DIR = "artifacts/portal-runs"
$env:HEADLESS = "false"

Write-Host "OXXO real-validation visible"
Write-Host "Este flujo llena datos y se detiene antes de Generar Factura."
Write-Host "Contexto: data/portal-contexts/oxxo-real-validation.sample.json"
Write-Host ""

npm run portal:run:oxxo-real-safe
