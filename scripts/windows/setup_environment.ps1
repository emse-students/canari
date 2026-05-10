# Installation Script for Mines App Environment

Write-Host "🔍 Verification de l'environnement de developpement..." -ForegroundColor Cyan

# 1. Verification de Make
try {
    $makeVersion = make --version
    Write-Host "✅ Make est installe." -ForegroundColor Green
}
catch {
    Write-Host "❌ Make n'est pas trouve." -ForegroundColor Red
    Write-Host "   Tentative d'installation via Winget..." -ForegroundColor Yellow
    winget install ezwinports.make
    if ($?) {
        Write-Host "✅ Make installe. Veuillez redemarrer votre terminal apres ce script." -ForegroundColor Green
    }
    else {
        Write-Host "⚠️ Echec de l'installation de Make. Installez-le manuellement." -ForegroundColor Red
    }
}

# 2. Verification de Rust
try {
    $cargoVersion = cargo --version
    Write-Host "✅ Rust/Cargo est installe." -ForegroundColor Green

    # Check wasm-pack
    try {
        wasm-pack --version | Out-Null
        Write-Host "✅ wasm-pack est installe." -ForegroundColor Green
    }
    catch {
        Write-Host "❌ wasm-pack n'est pas trouve." -ForegroundColor Red
        Write-Host "   Installation de wasm-pack..." -ForegroundColor Yellow
        cargo install wasm-pack
    }

}
catch {
    Write-Host "❌ Rust n'est pas trouve." -ForegroundColor Red
    Write-Host "   Tentative d'installation via Winget..." -ForegroundColor Yellow
    winget install Rustlang.Rustup
    Write-Host "⚠️ IMPORTANT : L'installation de Rust n'est pas finie !" -ForegroundColor Magenta
    Write-Host "   Veuillez executer 'rustup-init.exe' manuellement, choisir l'installation par defaut (1), puis redemarrer votre terminal."

    # On ne peut pas continuer pour les trucs Rust sans Rust
}

# 3. Verification de Bun
try {
    bun --version | Out-Null
    Write-Host "✅ Bun est installe." -ForegroundColor Green
}
catch {
    Write-Host "❌ Bun n'est pas trouve." -ForegroundColor Red
    Write-Host "   Installation de Bun..." -ForegroundColor Yellow
    winget install Oven-sh.Bun
    Write-Host "⚠️ Redemarrez votre terminal apres l'installation de Bun." -ForegroundColor Magenta
}

# 4. Installation des dependances Node.js (services backend)
Write-Host "`n📦 Installation des dependances backend..." -ForegroundColor Cyan

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
Write-Host "`n📦 Installation des dependances frontend..." -ForegroundColor Cyan
Write-Host "   👉 frontend"
Set-Location (Join-Path $root "frontend")
bun install
Set-Location $root

Write-Host "`n✅ Installation terminee." -ForegroundColor Green
Write-Host "👉 Lancez les services avec : make run-services" -ForegroundColor Cyan
Write-Host "👉 Puis le frontend avec   : cd frontend && bun run dev" -ForegroundColor Cyan
