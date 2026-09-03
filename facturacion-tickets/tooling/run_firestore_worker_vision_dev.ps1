$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

$credentialsPath = Join-Path (Get-Location) "secrets/firebase-service-account.json"

if (-not (Test-Path $credentialsPath)) {
  throw "No se encontro secrets/firebase-service-account.json. Coloca ahi la service account de Firebase Admin."
}

$env:GOOGLE_APPLICATION_CREDENTIALS = $credentialsPath
$env:FIREBASE_PROJECT_ID = "easysat-dev"
$env:FIREBASE_STORAGE_BUCKET = "easysat-dev.firebasestorage.app"
$env:CFDI_STORAGE_MODE = "firebase"
$env:WORKER_POLL_INTERVAL_MS = "3000"
$env:OCR_ENGINE = "google_vision"

Write-Host "Worker dev con Google Vision OCR escuchando jobs pending en easysat-dev..."
Write-Host "Requiere Cloud Vision API habilitada para el proyecto."
Write-Host "Ctrl+C para detener."
Write-Host ""

npm run firestore:watch
