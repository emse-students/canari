# Simple installation script
Write-Host "Installing JS dependencies..."

# 1. Shared TS Lib
Write-Host "--- libs/shared-ts ---"
Push-Location "libs/shared-ts"
npm install
npm run build
Pop-Location

# 2. Chat History Service
Write-Host "--- apps/chat-history-service ---"
Push-Location "apps/chat-history-service"
npm install
Pop-Location

# 3. Frontend
Write-Host "--- frontend ---"
Push-Location "frontend"
npm install
Pop-Location

Write-Host "JS dependencies installed."
