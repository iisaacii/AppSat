param(
  [Parameter(Mandatory = $true)]
  [string]$Uid,

  [string]$JobId,

  [Parameter(Mandatory = $true)]
  [string]$PortalUrl,

  [string]$RfcEmisor,

  [switch]$Reset
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

$argsList = @(
  "src/scripts/prepare-ai-portal-job.mjs",
  "--uid=$Uid",
  "--portal-url=$PortalUrl"
)

if ($JobId) {
  $argsList += "--job-id=$JobId"
}

if ($RfcEmisor) {
  $argsList += "--rfc-emisor=$RfcEmisor"
}

if ($Reset) {
  $argsList += "--reset"
}

node @argsList
