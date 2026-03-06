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
foreach ($proc in @('chat-gateway', 'cargo', 'node', 'mines-app')) {
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

# Fermer les fenêtres de terminal par leur titre (avec taskkill /T pour tuer l'arbre de processus)
Write-Host "`n[3/3] Fermeture des terminaux ouverts par start_all..." -ForegroundColor Yellow
$titles = @(
    "Chat Gateway (Rust)",
    "Chat History Service (Node)",
    "Auth Service (Node)",
    "User Service (Node)",
    "Frontend (Tauri)"
)
foreach ($title in $titles) {
    # taskkill /FI filtre par titre de fenêtre et /T tue tout l'arbre de processus
    $result = taskkill /FI "WINDOWTITLE eq $title" /T /F 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  -> Fenêtre '$title' fermée" -ForegroundColor DarkGray
    }
    # Fallback via MainWindowTitle (si le titre a changé légèrement)
    Get-Process -Name pwsh, powershell -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -eq $title } |
    ForEach-Object { taskkill /PID $_.Id /T /F 2>&1 | Out-Null }
}

Write-Host "`n===================================================" -ForegroundColor Green
Write-Host "  Tous les services ont été arrêtés !              " -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Green
