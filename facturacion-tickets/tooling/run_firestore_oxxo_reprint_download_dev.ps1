param(
  [Parameter(Mandatory = $true)]
  [string]$Uid,

  [Parameter(Mandatory = $true)]
  [string]$JobId,

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
$env:PORTAL_ARTIFACTS_DIR = "artifacts/portal-runs"
$env:HEADLESS = if ($Headless) { "true" } else { "false" }

Write-Host "Firestore OXXO reprint download"
Write-Host "UID: $Uid"
Write-Host "Job: $JobId"
Write-Host "HEADLESS: $env:HEADLESS"
Write-Host "Final submit: disabled; solo reimpresion/descarga"
Write-Host ""

node src/scripts/download-oxxo-reprint-job.mjs --uid=$Uid --job-id=$JobId
