# Installation des dependances Node.js (separe pour eviter blocage)
Write-Host "📦 Installation des dependances Node.js..." -ForegroundColor Cyan

# 1. Shared TS Lib
Write-Host "👉 libs/shared-ts"
Push-Location "libs/shared-ts"
npm install
npm run build
if ($LASTEXITCODE -eq 0) {
    Write-Host "   ✅ Build reussi." -ForegroundColor Green
}
else {
    Write-Host "   ❌ Echec du build shared-ts." -ForegroundColor Red
}
Pop-Location

# 2. Chat History Service
Write-Host "👉 apps/chat-history-service"
Push-Location "apps/chat-history-service"
npm install
Pop-Location

# 3. Frontend
Write-Host "👉 frontend"
Push-Location "frontend"
npm install
Pop-Location

Write-Host "✅ Termine." -ForegroundColor Green
