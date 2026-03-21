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

function Wait-Port {
    param(
        [Parameter(Mandatory = $true)] [string]$TargetHost,
        [Parameter(Mandatory = $true)] [int]$Port,
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $iar = $client.BeginConnect($TargetHost, $Port, $null, $null)
            $ok = $iar.AsyncWaitHandle.WaitOne(1000, $false)
            if ($ok -and $client.Connected) {
                $client.EndConnect($iar)
                $client.Close()
                return $true
            }
            $client.Close()
        }
        catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# --- Nettoyage des processus existants ---
Write-Host "`n[0/4] Nettoyage des processus existants..." -ForegroundColor Magenta

# Tuer les processus occupant les ports clés
foreach ($port in @(3000, 3001, 3002, 3003, 3004, 3005, 3006, 8080, 8081)) {
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
# Éviter les conflits de ports: les services applicatifs tournent en local, pas dans Docker
docker compose stop chat-gateway chat-delivery-service media-service 2>$null
docker compose rm -f chat-gateway chat-delivery-service media-service 2>$null

# Démarrer uniquement les dépendances d'infra
docker compose up -d zookeeper kafka redis mongo postgres minio
$dockerExit = $LASTEXITCODE
Pop-Location

if ($dockerExit -ne 0) {
    Write-Host "❌ Échec du démarrage Docker. Vérifiez que Docker Desktop est lancé, puis relancez le script." -ForegroundColor Red
    exit 1
}

Write-Host "  -> Vérification disponibilité Redis (6379) et Kafka (9092)..." -ForegroundColor DarkGray
if (-not (Wait-Port -TargetHost "127.0.0.1" -Port 6379 -TimeoutSeconds 60)) {
    Write-Host "❌ Redis (port 6379) indisponible. Arrêt du démarrage." -ForegroundColor Red
    exit 1
}
if (-not (Wait-Port -TargetHost "127.0.0.1" -Port 9092 -TimeoutSeconds 90)) {
    Write-Host "❌ Kafka (port 9092) indisponible. Arrêt du démarrage." -ForegroundColor Red
    exit 1
}
Write-Host "  ✓ Infrastructure Docker prête" -ForegroundColor Green

# 2. Build des librairies partagées
Write-Host "`n[2/4] Compilation des librairies partagées (shared-ts)..." -ForegroundColor Yellow
Push-Location -Path "libs/shared-ts"
npm install
npm run build
Pop-Location

# 3. Lancement des services backend dans des fenêtres séparées
Write-Host "`n[3/4] Lancement des services backend dans de nouvelles fenêtres..." -ForegroundColor Yellow

# Fichier de suivi des PIDs pour stop_all.ps1
$pidFile = Join-Path $PSScriptRoot "..\..\.canari_pids"
"" | Out-File -FilePath $pidFile -Encoding utf8 -Force

function Launch {
    param([string]$Title, [string]$Command)
    $p = Start-Process pwsh -ArgumentList "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='$Title'; $Command" -PassThru
    Add-Content -Path $pidFile -Value $p.Id
    Write-Host "  -> $Title (PID $($p.Id))" -ForegroundColor DarkGray
}

# Chat Gateway (Rust) - utilise le binaire release si dispo, sinon compile
Write-Host "  -> Lancement de Chat Gateway (port 3000/WS)" -ForegroundColor DarkGray
$gatewayBin = "apps\chat-gateway\target\release\chat-gateway.exe"
$gatewayEnv = "`$env:JWT_SECRET='$JWT_SECRET'; `$env:REDIS_URL='redis://127.0.0.1:6379'; `$env:KAFKA_BROKERS='localhost:9092'; `$env:DELIVERY_SERVICE_URL='http://localhost:3010'"
if (Test-Path $gatewayBin) {
    Launch "Chat Gateway (Rust)" "$gatewayEnv; & '$((Resolve-Path $gatewayBin).Path)'"
}
else {
    Launch "Chat Gateway (Rust)" "Set-Location apps/chat-gateway; $gatewayEnv; cargo run --release"
}

# Chat Delivery Service (NestJS)
Launch "Chat Delivery Service (Node)" "Set-Location apps/chat-delivery-service; `$env:PORT='3010'; `$env:KAFKA_BROKERS='localhost:9092'; `$env:REDIS_HOST='localhost'; `$env:REDIS_PORT='6379'; npm install; npm run start:dev"

# Auth Service (NestJS)
Launch "Auth Service (Node)" "Set-Location apps/auth-service; `$env:PORT='3012'; npm install; npm run start:dev"

# User Service (NestJS)
Launch "User Service (Node)" "Set-Location apps/user-service; `$env:PORT='3013'; npm install; npm run start:dev"

# Media Service (NestJS)
Launch "Media Service (Node)" "Set-Location apps/media-service; `$env:PORT='3011'; npm install; npm run start:dev"

# Channel Service (NestJS)
Launch "Channel Service (Node)" "Set-Location apps/channel-service; `$env:PORT='3014'; `$env:CHANNELS_MONGO_URI='mongodb://localhost:27017/channel_db'; `$env:CHANNELS_ENCRYPTION_SECRET='dev-channel-secret-change-me'; npm install; npm run start:dev"

# Post Service (NestJS)
Launch "Post Service (Node)" "Set-Location apps/post-service; `$env:PORT='3015'; `$env:STRIPE_SECRET_KEY=''; `$env:USER_SERVICE_URL='http://localhost:3013'; npm install; npm run start:dev"

# Form Service (NestJS)
Launch "Form Service (Node)" "Set-Location apps/form-service; `$env:PORT='3016'; `$env:FORMS_MONGO_URI='mongodb://localhost:27017/form_db'; `$env:STRIPE_SECRET_KEY=''; npm install; npm run start:dev"

# 4. Lancement du frontend (Tauri)
Write-Host "`n[4/4] Lancement du Frontend (Application Desktop Tauri)..." -ForegroundColor Yellow
Launch "Frontend (Tauri)" "Set-Location frontend; `$env:JWT_SECRET='$JWT_SECRET'; npm install; npm run tauri dev"

Write-Host "`n===================================================" -ForegroundColor Green
Write-Host "  Tous les services sont en cours de lancement !   " -ForegroundColor Green
Write-Host "  Une fenêtre d'application de bureau va s'ouvrir. "
Write-Host "===================================================" -ForegroundColor Green
