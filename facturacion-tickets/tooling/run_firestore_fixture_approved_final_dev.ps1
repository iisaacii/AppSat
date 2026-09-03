param(
  [string]$Uid = "demo_user"
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
$env:FIRESTORE_WORKER_UID = $Uid
$env:FIRESTORE_DEMO_APPROVE_FINAL_SUBMIT = "true"
$env:CFDI_STORAGE_MODE = "firebase"
$env:PORTAL_RUNNER_MODE = "playwright"
$env:PORTAL_USE_FIXTURE = "true"
$env:PORTAL_ALLOW_FINAL_SUBMIT = "true"
$env:PORTAL_FIXTURE_ALLOW_TEMPLATE_FINAL_SUBMIT = "true"
$env:HEADLESS = "true"

Write-Host "E2E dev: Firestore demo + Playwright fixture + approved final + Storage"
Write-Host "UID: $Uid"
Write-Host "1/3 Creando job demo aprobado..."
npm run firestore:seed-demo

Write-Host ""
Write-Host "2/3 Procesando con Playwright fixture hasta CFDI..."
npm run firestore:once

Write-Host ""
Write-Host "3/3 Inspeccionando job demo exacto..."
npm run firestore:inspect-latest -- --uid=$Uid --job-id=job_demo_001
