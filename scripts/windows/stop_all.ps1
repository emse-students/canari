# Mettre le chemin d'exécution à la racine du projet
Set-Location $PSScriptRoot\..\..

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "    Arrêt de Canari App (Toutes les briques)       " -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

Write-Host "`n[1/2] Arrêt de l'infrastructure Docker..." -ForegroundColor Yellow
Push-Location -Path "infrastructure/local"
docker compose down
Pop-Location

Write-Host "`n[2/3] Fermeture des services backend..." -ForegroundColor Yellow

# Tuer par nom de processus connu
foreach ($proc in @('chat-gateway', 'cargo', 'node', 'canari')) {
    $found = Get-Process -Name $proc -ErrorAction SilentlyContinue
    if ($found) {
        $found | Stop-Process -Force -ErrorAction SilentlyContinue
        Write-Host "  -> $proc arrêté" -ForegroundColor DarkGray
    }
}

# Tuer les processus Java (anciens) si existants
Get-Process -Name "java" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Libérer les ports clés
foreach ($port in @(3000, 8080, 8081)) {
    $pids = (netstat -ano | Select-String "LISTENING" | Select-String ":$port\s" | ForEach-Object {
            ($_.Line -split '\s+')[-1]
        } | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique)
    foreach ($p in $pids) {
        try {
            Stop-Process -Id ([int]$p) -Force -ErrorAction SilentlyContinue
            Write-Host "  -> Port $port (PID $p) libéré" -ForegroundColor DarkGray
        }
        catch {}
    }
}

# Fermer les terminaux via les PIDs enregistrés par start_all.ps1
Write-Host "`n[3/3] Fermeture des terminaux ouverts par start_all..." -ForegroundColor Yellow
$pidFile = Join-Path $PSScriptRoot "..\..\.canari_pids"
if (Test-Path $pidFile) {
    $savedPids = Get-Content $pidFile | Where-Object { $_ -match '^\s*\d+\s*$' }
    foreach ($p in $savedPids) {
        $targetPid = [int]$p.Trim()
        $result = taskkill /PID $targetPid /T /F 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  -> PID $targetPid et son arbre arrêtés" -ForegroundColor DarkGray
        }
    }
    Remove-Item $pidFile -Force
    Write-Host "  -> Fichier de suivi .canari_pids supprimé" -ForegroundColor DarkGray
}
else {
    Write-Host "  -> Aucun fichier .canari_pids trouvé (services déjà arrêtés ou lancés manuellement)" -ForegroundColor DarkYellow
    # Fallback : fermeture par titre de fenêtre
    $titles = @(
        "Chat Gateway (Rust)",
        "Chat Delivery Service (Node)",
        "Auth Service (Node)",
        "User Service (Node)",
        "Media Service (Node)",
        "Frontend (Tauri)"
    )
    foreach ($title in $titles) {
        taskkill /FI "WINDOWTITLE eq $title" /T /F 2>&1 | Out-Null
        Get-Process -Name pwsh, powershell -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like "*$title*" } |
        ForEach-Object { taskkill /PID $_.Id /T /F 2>&1 | Out-Null }
    }
}

Write-Host "`n===================================================" -ForegroundColor Green
Write-Host "  Tous les services ont été arrêtés !              " -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Green
