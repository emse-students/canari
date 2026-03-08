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

# 3. Installation des dependances Node.js
Write-Host "`n📦 Installation des dependances Node.js..." -ForegroundColor Cyan

# 3.1 Shared TS Lib
Write-Host "   👉 libs/shared-ts"
Set-Location "libs/shared-ts"
npm install
npm run build
if ($LASTEXITCODE -eq 0) {
    Write-Host "      ✅ Build reussi." -ForegroundColor Green
}
else {
    Write-Host "      ❌ Echec du build." -ForegroundColor Red
}
Set-Location ../../

# 3.2 Chat Delivery Service
Write-Host "   👉 apps/chat-delivery-service"
Set-Location "apps/chat-delivery-service"
npm install
Set-Location ../../

# 3.3 Auth Service
Write-Host "   👉 apps/auth-service"
Set-Location "apps/auth-service"
npm install
Set-Location ../../

# 3.4 User Service
Write-Host "   👉 apps/user-service"
Set-Location "apps/user-service"
npm install
Set-Location ../../

# 3.5 Media Service
Write-Host "   👉 apps/media-service"
Set-Location "apps/media-service"
npm install
Set-Location ../../

# 3.6 Frontend
Write-Host "   👉 frontend"
Set-Location "frontend"
npm install
Set-Location ../

Write-Host "`n✅ Installation des dependances terminee." -ForegroundColor Green
Write-Host "👉 Veuillez lire DEVELOPMENT.md pour la suite." -ForegroundColor Cyan
