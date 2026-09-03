param(
  [Parameter(Mandatory = $true)]
  [string]$Uid,

  [ValidateSet("mock", "google_vision")]
  [string]$OcrEngine = "google_vision",

  [switch]$Headless
)

$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

$credentialsPath = Join-Path (Get-Location) "secrets/firebase-service-account.json"

if (-not (Test-Path $credentialsPath)) {
  throw "No se encontro secrets/firebase-service-account.json. Coloca ahi la service account de Firebase Admin."
}

$env:GOOGLE_APPLICATION_CREDENTIALS = $credentialsPath
$env:FIREBASE_PROJECT_ID = "easysat-dev"
$env:FIREBASE_STORAGE_BUCKET = "easysat-dev.firebasestorage.app"
$env:FIRESTORE_WORKER_UID = $Uid
$env:CFDI_STORAGE_MODE = "firebase"
$env:OCR_ENGINE = $OcrEngine
$env:PORTAL_RUNNER_MODE = "playwright"
$env:PORTAL_USE_FIXTURE = "false"
$env:PORTAL_ALLOW_FINAL_SUBMIT = "false"
$env:PORTAL_FIXTURE_ALLOW_TEMPLATE_FINAL_SUBMIT = "false"
$env:PORTAL_ARTIFACTS_DIR = "artifacts/portal-runs"
$env:HEADLESS = if ($Headless) { "true" } else { "false" }

Write-Host "Firestore real-safe once"
Write-Host "UID: $Uid"
Write-Host "OCR: $OcrEngine"
Write-Host "HEADLESS: $env:HEADLESS"
Write-Host "Portal fixture: false"
Write-Host "Final submit: disabled"
Write-Host ""
Write-Host "Procesando un job pending/retry_scheduled del lab..."

npm run firestore:once
