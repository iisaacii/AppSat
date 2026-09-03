param(
  [Parameter(Mandatory = $true)]
  [string]$Uid,

  [ValidateSet("mock", "google_vision")]
  [string]$OcrEngine = "google_vision",

  [switch]$Headless,

  [switch]$AllowFinalSubmit,

  [switch]$ForceAi
)

$ErrorActionPreference = "Stop"

Set-Location (Join-Path $PSScriptRoot "..")

$credentialsPath = Join-Path (Get-Location) "secrets/firebase-service-account.json"

if (-not (Test-Path $credentialsPath)) {
  throw "No se encontro secrets/firebase-service-account.json. Coloca ahi la service account de Firebase Admin."
}

if ([string]::IsNullOrWhiteSpace($env:GEMINI_API_KEY) -and [string]::IsNullOrWhiteSpace($env:GOOGLE_API_KEY) -and [string]::IsNullOrWhiteSpace($env:GOOGLE_GENERATIVE_AI_API_KEY)) {
  throw "Configura GEMINI_API_KEY, GOOGLE_API_KEY o GOOGLE_GENERATIVE_AI_API_KEY en esta terminal antes de correr Stagehand lab."
}

$env:GOOGLE_APPLICATION_CREDENTIALS = $credentialsPath
$env:FIREBASE_PROJECT_ID = "appsat-dev"
$env:FIREBASE_STORAGE_BUCKET = "appsat-dev.firebasestorage.app"
$env:FIRESTORE_WORKER_UID = $Uid
$env:CFDI_STORAGE_MODE = "firebase"
$env:OCR_ENGINE = $OcrEngine
$env:PORTAL_RUNNER_MODE = "playwright"
$env:PORTAL_USE_FIXTURE = "false"
$env:AI_NAVIGATOR_MODE = "gemini"
$env:AI_GEMINI_MODEL = "gemini-3.1-flash-lite"
$env:AI_NAVIGATOR_ALLOW_FINAL_SUBMIT = if ($AllowFinalSubmit) { "true" } else { "false" }
$env:BILLING_FORCE_AI_NAVIGATION = if ($ForceAi) { "true" } else { "false" }
$env:PORTAL_ALLOW_FINAL_SUBMIT = "false"
$env:PORTAL_FIXTURE_ALLOW_TEMPLATE_FINAL_SUBMIT = "false"
$env:STAGEHAND_LAB_ENABLED = "true"
$env:STAGEHAND_ENV = if ([string]::IsNullOrWhiteSpace($env:STAGEHAND_ENV)) { "BROWSERBASE" } else { $env:STAGEHAND_ENV }
$env:STAGEHAND_MODEL = "google/gemini-3.1-flash-lite"
$env:STAGEHAND_ALLOW_FINAL_SUBMIT = if ($AllowFinalSubmit) { "true" } else { "false" }
$env:STAGEHAND_CACHE_DIR = "data/stagehand-cache"
$env:STAGEHAND_REGISTRY_DIR = "data/stagehand-registry"
$env:STAGEHAND_MAX_STEPS = "40"
$env:PORTAL_ARTIFACTS_DIR = "artifacts/portal-runs"
$env:HEADLESS = if ($Headless) { "true" } else { "false" }

Write-Host "Firestore Stagehand lab once"
Write-Host "UID: $Uid"
Write-Host "OCR: $OcrEngine"
Write-Host "HEADLESS: $env:HEADLESS"
Write-Host "Portal fixture: false"
Write-Host "Force Capa B: $env:BILLING_FORCE_AI_NAVIGATION"
Write-Host "Stagehand final submit: $env:STAGEHAND_ALLOW_FINAL_SUBMIT"
Write-Host "CFDI storage: firebase"
Write-Host ""
Write-Host "Procesando un job pending/retry_scheduled del lab con Stagehand..."

npm run firestore:once
