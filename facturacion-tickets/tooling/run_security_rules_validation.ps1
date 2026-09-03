$ErrorActionPreference = "Stop"

$serviceRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = Split-Path -Parent $serviceRoot
$javaHome = "C:\Program Files\Android\Android Studio\jbr"
$firebaseCli = Join-Path $serviceRoot "node_modules\.bin\firebase.cmd"
$firebaseConfig = Join-Path $repositoryRoot "firebase.security-test.json"

if (-not (Test-Path (Join-Path $javaHome "bin\java.exe"))) {
  throw "No se encontro Java en Android Studio: $javaHome"
}

if (-not (Test-Path $firebaseCli)) {
  throw "No se encontro Firebase CLI local. Ejecuta npm install en $serviceRoot"
}

$env:JAVA_HOME = $javaHome
$env:Path = "$(Join-Path $javaHome 'bin');$env:Path"
$env:NO_UPDATE_NOTIFIER = "1"

Push-Location $serviceRoot
try {
  $firebaseOutput = & $firebaseCli emulators:exec `
    --config $firebaseConfig `
    --only firestore,storage `
    --project demo-easysat-rules-test `
    "npm run security:rules:test" 2>&1
  $firebaseExitCode = $LASTEXITCODE
  $firebaseOutput | ForEach-Object { Write-Output $_ }

  if ($firebaseExitCode -ne 0 -and -not ($firebaseOutput -match "SECURITY_RULES_VALIDATION_OK")) {
    throw "La validacion de reglas fallo con codigo $firebaseExitCode"
  }

  if ($firebaseExitCode -ne 0) {
    Write-Warning "Firebase CLI devolvio $firebaseExitCode al cerrar emuladores, pero todas las aserciones terminaron correctamente."
  }
}
finally {
  Pop-Location
}
