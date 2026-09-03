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
  throw "Configura GEMINI_API_KEY, GOOGLE_API_KEY o GOOGLE_GENERATIVE_AI_API_KEY en esta terminal antes de correr Capa B Gemini."
}

$env:GOOGLE_APPLICATION_CREDENTIALS = $credentialsPath
$env:FIREBASE_PROJECT_ID = "easysat-dev"
$env:FIREBASE_STORAGE_BUCKET = "easysat-dev.firebasestorage.app"
$env:FIRESTORE_WORKER_UID = $Uid
$env:CFDI_STORAGE_MODE = "firebase"
$env:OCR_ENGINE = $OcrEngine
$env:PORTAL_RUNNER_MODE = "playwright"
$env:PORTAL_USE_FIXTURE = "false"
$env:AI_NAVIGATOR_MODE = "gemini"
$env:AI_GEMINI_MODEL = "gemini-3.1-flash-lite"
$env:AI_GEMINI_REQUEST_TIMEOUT_MS = "120000"
$env:AI_NAVIGATOR_MAX_TURNS = "8"
$env:AI_NAVIGATOR_MAX_ACTIONS = "20"
$env:AI_NAVIGATOR_ALLOW_FINAL_SUBMIT = if ($AllowFinalSubmit) { "true" } else { "false" }
$env:BILLING_FORCE_AI_NAVIGATION = if ($ForceAi) { "true" } else { "false" }
$env:PORTAL_ALLOW_FINAL_SUBMIT = "false"
$env:PORTAL_FIXTURE_ALLOW_TEMPLATE_FINAL_SUBMIT = "false"
$env:PORTAL_ARTIFACTS_DIR = "artifacts/portal-runs"
$env:HEADLESS = if ($Headless) { "true" } else { "false" }

Write-Host "Firestore Capa B Gemini once"
Write-Host "UID: $Uid"
Write-Host "OCR: $OcrEngine"
Write-Host "HEADLESS: $env:HEADLESS"
Write-Host "Portal fixture: false"
Write-Host "Force Capa B: $env:BILLING_FORCE_AI_NAVIGATION"
Write-Host "AI final submit: $env:AI_NAVIGATOR_ALLOW_FINAL_SUBMIT"
Write-Host "CFDI storage: firebase"
Write-Host ""
Write-Host "Procesando un job pending/retry_scheduled del lab con Gemini..."

npm run firestore:once
