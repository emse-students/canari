# Installation Script for Mines App Environment

<#
  Wrapper (Windows) — Deprecated helper

  Ce fichier existait comme script d'installation autonome. Le projet utilise
  maintenant le script principal `scripts/setup-env.ps1`. Ce wrapper appelle
  le script principal pour garder la compatibilité tout en évitant la
  duplication de logique.
#>

Write-Host "Launcher wrapper: appel du script principal scripts/setup-env.ps1" -ForegroundColor Cyan

# Change to repo root (parent of 'scripts') and invoke the canonical script
$scriptRoot = Split-Path -Parent $PSScriptRoot
Push-Location $scriptRoot
try {
    if (Test-Path "scripts\setup-env.ps1") {
        Write-Host "Utilisation de scripts\setup-env.ps1" -ForegroundColor Green
        & "powershell" -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-env.ps1" @args
    }
    else {
        Write-Host "Le script scripts\setup-env.ps1 est introuvable. Exécutez manuellement le script principal." -ForegroundColor Yellow
    }
}
finally {
    Pop-Location
}

# 1. Verification de Make
try {
    $makeVersion = make --version
    Write-Host "Make est installe." -ForegroundColor Green
}
catch {
    Write-Host "Make n'est pas trouve." -ForegroundColor Red
    Write-Host "   Tentative d'installation via Winget..." -ForegroundColor Yellow
    winget install ezwinports.make
    if ($?) {
        Write-Host "Make installe. Veuillez redemarrer votre terminal apres ce script." -ForegroundColor Green
    }
    else {
        Write-Host "⚠️ Echec de l'installation de Make. Installez-le manuellement." -ForegroundColor Red
    }
}

# 2. Verification de Rust
try {
    $cargoVersion = cargo --version
    Write-Host "Rust/Cargo est installe." -ForegroundColor Green

    # Check wasm-pack
    try {
        wasm-pack --version | Out-Null
        Write-Host "wasm-pack est installe." -ForegroundColor Green
    }
    catch {
        Write-Host "wasm-pack n'est pas trouve." -ForegroundColor Red
        Write-Host "   Installation de wasm-pack..." -ForegroundColor Yellow
        cargo install wasm-pack
    }

}
catch {
    Write-Host "Rust n'est pas trouve." -ForegroundColor Red
    Write-Host "   Tentative d'installation via Winget..." -ForegroundColor Yellow
    winget install Rustlang.Rustup
    Write-Host "IMPORTANT : L'installation de Rust n'est pas finie !" -ForegroundColor Magenta
    Write-Host "   Veuillez executer 'rustup-init.exe' manuellement, choisir l'installation par defaut (1), puis redemarrer votre terminal."

    # On ne peut pas continuer pour les trucs Rust sans Rust
}

# 3. Verification de Bun
try {
    bun --version | Out-Null
    Write-Host "Bun est installe." -ForegroundColor Green
}
catch {
    Write-Host "Bun n'est pas trouve." -ForegroundColor Red
    Write-Host "   Installation de Bun..." -ForegroundColor Yellow
    winget install Oven-sh.Bun
    Write-Host "⚠️ Redemarrez votre terminal apres l'installation de Bun." -ForegroundColor Magenta
}

# 4. Installation des dependances Node.js (services backend)
Write-Host "`nInstallation des dependances backend..." -ForegroundColor Cyan

$services = @(
    "apps/chat-delivery-service",
    "apps/core-service",
    "apps/media-service",
    "apps/social-service"
)

$root = (Get-Location).Path
foreach ($svc in $services) {
    Write-Host "   👉 $svc"
    Set-Location (Join-Path $root $svc)
    npm install
    Set-Location $root
}

# 5. Installation des dependances frontend (Bun)
Write-Host "(Obsolète) Voir scripts/setup-env.ps1 pour les étapes d'installation" -ForegroundColor Yellow
Write-Host "`nInstallation terminee." -ForegroundColor Green
Write-Host "Lancez les services avec : make run-services" -ForegroundColor Cyan
Write-Host "Puis le frontend avec   : cd frontend && bun run dev" -ForegroundColor Cyan
