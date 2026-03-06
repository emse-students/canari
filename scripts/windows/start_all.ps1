# Mettre le chemin d'exécution à la racine du projet (deux dossiers plus haut)
Set-Location $PSScriptRoot\..\..

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "    Démarrage de Canari App (Toutes les briques)   " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# --- Nettoyage des processus existants ---
Write-Host "`n[0/4] Nettoyage des processus existants..." -ForegroundColor Magenta

# Tuer les processus occupant les ports clés
foreach ($port in @(3000, 8080, 8081)) {
    $pids = (netstat -ano | Select-String "LISTENING" | Select-String ":$port\s" | ForEach-Object {
            ($_.Line -split '\s+')[-1]
        } | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
    foreach ($p in $pids) {
        try {
            Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue
            Write-Host "  -> Processus $p (port $port) arrêté" -ForegroundColor DarkGray
        }
        catch {}
    }
}

# Tuer les processus par nom (instances précédentes)
foreach ($proc in @('chat-gateway', 'cargo')) {
    Get-Process -Name $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1

# 1. Démarrer l'infrastructure Docker (Kafka, Redis, Authentik...)
Write-Host "`n[1/4] Démarrage de l'infrastructure Docker..." -ForegroundColor Yellow
Push-Location -Path "infrastructure/local"
docker compose up -d
Pop-Location

# 2. Build des librairies partagées
Write-Host "`n[2/4] Compilation des librairies partagées (shared-ts)..." -ForegroundColor Yellow
Push-Location -Path "libs/shared-ts"
npm install
npm run build
Pop-Location

# 3. Lancement des services backend dans des fenêtres séparées
Write-Host "`n[3/4] Lancement des services backend dans de nouvelles fenêtres..." -ForegroundColor Yellow

# Chat Gateway (Rust) - utilise le binaire release si dispo, sinon compile
Write-Host "  -> Lancement de Chat Gateway (port 3000/WS)" -ForegroundColor DarkGray
$gatewayBin = "apps\chat-gateway\target\release\chat-gateway.exe"
if (Test-Path $gatewayBin) {
    Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Chat Gateway (Rust)'; & '$((Resolve-Path $gatewayBin).Path)'"
}
else {
    Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Chat Gateway (Rust)'; Set-Location apps/chat-gateway; cargo run --release"
}

# Chat History Service (NestJS)
Write-Host "  -> Lancement de Chat History Service" -ForegroundColor DarkGray
Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Chat History Service (Node)'; Set-Location apps/chat-history-service; npm install; npm run start:dev"

# Auth Service (NestJS)
Write-Host "  -> Lancement de Auth Service" -ForegroundColor DarkGray
Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Auth Service (Node)'; Set-Location apps/auth-service; npm install; npm run start:dev"

# User Service (NestJS)
Write-Host "  -> Lancement de User Service" -ForegroundColor DarkGray
Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='User Service (Node)'; Set-Location apps/user-service; npm install; npm run start:dev"

# 4. Lancement du frontend (Tauri)
Write-Host "`n[4/4] Lancement du Frontend (Application Desktop Tauri)..." -ForegroundColor Yellow
Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Frontend (Tauri)'; Set-Location frontend; npm install; npm run tauri dev"

Write-Host "`n===================================================" -ForegroundColor Green
Write-Host "  Tous les services sont en cours de lancement !   " -ForegroundColor Green
Write-Host "  Une fenêtre d'application de bureau va s'ouvrir. " 
Write-Host "===================================================" -ForegroundColor Green
