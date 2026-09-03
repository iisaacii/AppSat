param(
  [string]$Uid,
  [string]$JobId
)

$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

$credentialsPath = Join-Path (Get-Location) "secrets/firebase-service-account.json"

if (-not (Test-Path $credentialsPath)) {
  throw "No se encontro secrets/firebase-service-account.json. Coloca ahi la service account de Firebase Admin."
}

$env:GOOGLE_APPLICATION_CREDENTIALS = $credentialsPath
$env:FIREBASE_PROJECT_ID = "appsat-dev"
$env:FIREBASE_STORAGE_BUCKET = "appsat-dev.firebasestorage.app"

$argsList = @("src/scripts/inspect-latest-ocr-job.mjs")

if ($Uid) {
  $argsList += "--uid=$Uid"
}

if ($JobId) {
  $argsList += "--job-id=$JobId"
}

node @argsList
