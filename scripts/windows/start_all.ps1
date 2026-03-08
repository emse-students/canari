# Mettre le chemin d'exécution à la racine du projet (deux dossiers plus haut)
Set-Location $PSScriptRoot\..\..

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "    Démarrage de Canari App (Toutes les briques)   " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# --- Chargement des variables d'environnement ---
Write-Host "`nChargement des variables d'environnement..." -ForegroundColor Cyan
$JWT_SECRET = ""

# Lire JWT_SECRET depuis frontend/.env
if (Test-Path "frontend/.env") {
    $envContent = Get-Content "frontend/.env" -Raw
    if ($envContent -match 'VITE_JWT_SECRET=([^\r\n]+)') {
        $JWT_SECRET = $matches[1]
        Write-Host "  ✓ JWT_SECRET chargé depuis frontend/.env" -ForegroundColor Green
    }
}

# Si toujours pas de JWT_SECRET, en générer un
if ([string]::IsNullOrWhiteSpace($JWT_SECRET)) {
    $JWT_SECRET = -join ((1..32 | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }))
    Write-Host "  ✓ JWT_SECRET généré: $JWT_SECRET" -ForegroundColor Yellow

    # Sauvegarder dans frontend/.env si le fichier n'existe pas
    if (-not (Test-Path "frontend/.env")) {
        "VITE_JWT_SECRET=$JWT_SECRET" | Out-File -FilePath "frontend/.env" -Encoding utf8
    }
}

# --- Nettoyage des processus existants ---
Write-Host "`n[0/4] Nettoyage des processus existants..." -ForegroundColor Magenta

# Tuer les processus occupant les ports clés
foreach ($port in @(3000, 3001, 3002, 8080, 8081)) {
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
$gatewayEnv = "`$env:JWT_SECRET='$JWT_SECRET'; `$env:REDIS_URL='redis://127.0.0.1:6379'; `$env:KAFKA_BROKERS='localhost:9092'; `$env:DELIVERY_SERVICE_URL='http://localhost:3001'"
if (Test-Path $gatewayBin) {
    Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Chat Gateway (Rust)'; $gatewayEnv; & '$((Resolve-Path $gatewayBin).Path)'"
}
else {
    Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Chat Gateway (Rust)'; Set-Location apps/chat-gateway; $gatewayEnv; cargo run --release"
}

# Chat Delivery Service (NestJS)
Write-Host "  -> Lancement de Chat Delivery Service" -ForegroundColor DarkGray
Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Chat Delivery Service (Node)'; Set-Location apps/chat-delivery-service; npm install; npm run start:dev"

# Auth Service (NestJS)
Write-Host "  -> Lancement de Auth Service" -ForegroundColor DarkGray
Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Auth Service (Node)'; Set-Location apps/auth-service; npm install; npm run start:dev"

# User Service (NestJS)
Write-Host "  -> Lancement de User Service" -ForegroundColor DarkGray
Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='User Service (Node)'; Set-Location apps/user-service; npm install; npm run start:dev"

# Media Service (NestJS)
Write-Host "  -> Lancement de Media Service" -ForegroundColor DarkGray
Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Media Service (Node)'; Set-Location apps/media-service; npm install; npm run start:dev"

# 4. Lancement du frontend (Tauri)
Write-Host "`n[4/4] Lancement du Frontend (Application Desktop Tauri)..." -ForegroundColor Yellow
Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Frontend (Tauri)'; Set-Location frontend; `$env:JWT_SECRET='$JWT_SECRET'; npm install; npm run tauri dev"

Write-Host "`n===================================================" -ForegroundColor Green
Write-Host "  Tous les services sont en cours de lancement !   " -ForegroundColor Green
Write-Host "  Une fenêtre d'application de bureau va s'ouvrir. "
Write-Host "===================================================" -ForegroundColor Green
