#
# setup-env.ps1 - Environment & Secrets Management Script (PowerShell)
# Automatically configures .env files and synchronizes JWT secrets
#
# Usage:
#   .\scripts\setup-env.ps1 [-Prod] [-SyncOnly] [-NoBackup]
#
# Options:
#   -Prod          Production mode (requires all variables)
#   -SyncOnly      Only sync secrets, don't create new .env files
#   -NoBackup      Don't backup existing .env files
#   -Help          Show this help message
#

param(
    [switch]$Prod,
    [switch]$SyncOnly,
    [switch]$NoBackup,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# ──────────────────────────────────────────────────────────────────────────────
# Setup
# ──────────────────────────────────────────────────────────────────────────────

$ScriptDir = $PSScriptRoot
$ProjectRoot = Split-Path -Parent $ScriptDir
$FrontendDir = Join-Path $ProjectRoot "frontend"
$InfraDir = Join-Path $ProjectRoot "infrastructure"

# Colors
function Write-Info { Write-Host "[setup-env] $args" -ForegroundColor Cyan }
function Write-Success { Write-Host "✓ $args" -ForegroundColor Green }
function Write-Warn { Write-Host "⚠ $args" -ForegroundColor Yellow }
function Write-Error { Write-Host "✗ $args" -ForegroundColor Red }

# ──────────────────────────────────────────────────────────────────────────────
# Helper Functions
# ──────────────────────────────────────────────────────────────────────────────

function Show-Help {
    @"
setup-env.ps1 - Environment & Secrets Management Script

Usage:
  .\scripts\setup-env.ps1 [-Prod] [-SyncOnly] [-NoBackup]

Options:
  -Prod        Production mode (requires all variables)
  -SyncOnly    Only sync secrets, don't create new .env files
  -NoBackup    Don't backup existing .env files
  -Help        Show this help message

Examples:
  # Development: Create .env files and generate secrets
  .\scripts\setup-env.ps1

  # Production: Sync existing secrets
  .\scripts\setup-env.ps1 -Prod -SyncOnly

  # Sync only (no file creation)
  .\scripts\setup-env.ps1 -SyncOnly
"@
    exit 0
}

function New-Secret {
    # Generate 64-char hex string (32 bytes)
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::new()
    $rng.GetBytes($bytes)
    $secret = $bytes | ForEach-Object { "{0:x2}" -f $_ }
    return -join $secret
}

function Test-Secret {
    param([string]$Secret)

    if ($Secret -match "^[0-9a-f]{64}$") {
        return $true
    }
    return $false
}

function Read-EnvVar {
    param(
        [string]$File,
        [string]$Var
    )

    if (-not (Test-Path $File)) {
        return ""
    }

    $line = Get-Content $File | Where-Object { $_ -match "^${Var}=" } | Select-Object -First 1
    if ($line) {
        return $line -replace "^${Var}=", ""
    }
    return ""
}

function Write-EnvVar {
    param(
        [string]$File,
        [string]$Var,
        [string]$Value
    )

    if (-not (Test-Path $File)) {
        "$Var=$Value" | Add-Content $File
        return
    }

    $content = Get-Content $File -Raw

    if ($content -match "(?m)^${Var}=") {
        $updatedContent = [System.Text.RegularExpressions.Regex]::Replace(
            $content,
            "(?m)^${Var}=.*$",
            "${Var}=${Value}"
        )
    }
    else {
        $separator = "`n"
        if ($content -and -not $content.EndsWith("`n")) {
            $updatedContent = "${content}${separator}${Var}=${Value}${separator}"
        }
        else {
            $updatedContent = "${content}${Var}=${Value}${separator}"
        }
    }

    $updatedContent | Set-Content $File -NoNewline
}

function Backup-IfExists {
    param([string]$File)

    if ((Test-Path $File) -and -not $NoBackup) {
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $backup = "${File}.backup_${timestamp}"
        Copy-Item $File $backup
        return $backup
    }
    return ""
}

function Normalize-ImagePrefix {
    param([string]$File)

    if (-not (Test-Path $File)) {
        return
    }

    $imagePrefix = Read-EnvVar $File "IMAGE_PREFIX"
    if ($imagePrefix -eq "your-github-org/canari") {
        Write-Warn "Legacy IMAGE_PREFIX detected in $(Split-Path $File -Leaf), updating to emse-students/canari"
        Write-EnvVar $File "IMAGE_PREFIX" "emse-students/canari"
        Write-Success "IMAGE_PREFIX migrated to emse-students/canari"
    }
}

# ──────────────────────────────────────────────────────────────────────────────
# Main Logic
# ──────────────────────────────────────────────────────────────────────────────

if ($Help) {
    Show-Help
}

Write-Info "Environment Setup Script"
Write-Info "Project: $ProjectRoot"
Write-Info ""

# Check prerequisites
Write-Info "Checking prerequisites..."
if (-not (Test-Path $FrontendDir) -or -not (Test-Path $InfraDir)) {
    Write-Error "Project structure not found from script path."
    Write-Error "Expected folders: '$FrontendDir' and '$InfraDir'"
    exit 1
}
Write-Success "Project structure detected"

# ──────────────────────────────────────────────────────────────────────────────
# Frontend Setup
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Setting up frontend environment..."

$FrontendEnv = Join-Path $FrontendDir ".env"
$FrontendExample = Join-Path $FrontendDir ".env.example"

if (-not (Test-Path $FrontendExample)) {
    Write-Error "Frontend .env.example not found at $FrontendExample"
    exit 1
}

if ((-not (Test-Path $FrontendEnv)) -and -not $SyncOnly) {
    Write-Info "Creating $FrontendEnv from .env.example..."
    Backup-IfExists $FrontendEnv
    Copy-Item $FrontendExample $FrontendEnv
    Write-Success "Frontend .env created"
}
elseif (Test-Path $FrontendEnv) {
    Write-Success "Frontend .env already exists"
}

# ──────────────────────────────────────────────────────────────────────────────
# Infrastructure Setup
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Setting up infrastructure environment..."

$InfraEnv = Join-Path $InfraDir ".env"
$InfraExample = Join-Path $InfraDir ".env.example"

if (-not (Test-Path $InfraExample)) {
    Write-Error "Infrastructure .env.example not found at $InfraExample"
    exit 1
}

if ((-not (Test-Path $InfraEnv)) -and -not $SyncOnly) {
    Write-Info "Creating $InfraEnv from .env.example..."
    Backup-IfExists $InfraEnv
    Copy-Item $InfraExample $InfraEnv
    Write-Success "Infrastructure .env created"
}
elseif (Test-Path $InfraEnv) {
    Write-Success "Infrastructure .env already exists"
}

# Migrate legacy placeholders in infrastructure env
Normalize-ImagePrefix $InfraEnv

# ──────────────────────────────────────────────────────────────────────────────
# JWT Secret Synchronization
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Synchronizing JWT secrets..."

$FrontendSecret = ""
$InfraSecret = ""

if (Test-Path $InfraEnv) {
    $InfraSecret = Read-EnvVar $InfraEnv "JWT_SECRET"
}

# Check if we need to generate a new secret
$ShouldGenerate = $false
if ([string]::IsNullOrEmpty($FrontendSecret) -or $FrontendSecret -eq "dev_secret_change_me_in_env_file_never_expose") {
    $ShouldGenerate = $true
}
elseif (-not (Test-Secret $FrontendSecret)) {
    Write-Warn "Frontend secret is not a valid 64-char hex string"
    $ShouldGenerate = $true
}

if ($ShouldGenerate) {
    if ($Prod) {
        Write-Error "Production mode requires a valid JWT_SECRET to be already configured"
        Write-Error "Set JWT_SECRET in both .env files and retry with -Prod"
        exit 1
    }

    Write-Info "Generating new JWT secret..."
    $NewSecret = New-Secret

    if (-not (Test-Secret $NewSecret)) {
        Write-Error "Failed to generate valid secret"
        exit 1
    }

    Write-Success "Generated new secret: $($NewSecret.Substring(0, 16))..."
    $FrontendSecret = $NewSecret
    $InfraSecret = $NewSecret
}
else {
    # Secrets exist, check if they're in sync
    if ($FrontendSecret -ne $InfraSecret) {
        if (-not $Prod) {
            Write-Info "Frontend and infrastructure secrets don't match, synchronizing..."
            $InfraSecret = $FrontendSecret
        }
        else {
            Write-Error "Frontend and infrastructure JWT_SECRET don't match!"
            Write-Error "Frontend: $($FrontendSecret.Substring(0, 16))..."
            Write-Error "Infrastructure: $($InfraSecret.Substring(0, 16))..."
            Write-Error "In production, they MUST be identical"
            exit 1
        }
    }
}

# Write secrets to files
if (Test-Path $FrontendEnv) {
    Write-EnvVar $FrontendEnv "VITE_JWT_SECRET" $FrontendSecret
    Write-EnvVar $FrontendEnv "VITE_MEDIA_URL" "http://localhost:3011"
    Write-EnvVar $FrontendEnv "VITE_MEDIA_MAX_SIZE_MB" "50"

    # VITE_TENOR_API_KEY (optionnel - clé demo incluse dans le code)
    $currentTenorKey = Read-EnvVar $FrontendEnv "VITE_TENOR_API_KEY"
    if ($currentTenorKey -eq "") {
        Write-EnvVar $FrontendEnv "VITE_TENOR_API_KEY" ""
    }

    Write-Success "Updated frontend VITE_JWT_SECRET"
}

if (Test-Path $InfraEnv) {
    Write-EnvVar $InfraEnv "JWT_SECRET" $InfraSecret
    Write-Success "Updated infrastructure JWT_SECRET"
}

# ──────────────────────────────────────────────────────────────────────────────
# Validation
# ──────────────────────────────────────────────────────────────────────────────
Write-Info "Validating configuration..."

# Check frontend required vars
if (Test-Path $FrontendEnv) {
    $FrontendCheck = Read-EnvVar $FrontendEnv "VITE_JWT_SECRET"
    if (Test-Secret $FrontendCheck) {
        Write-Success "Frontend VITE_JWT_SECRET is valid"
    }
    else {
        Write-Error "Frontend VITE_JWT_SECRET is invalid or missing"
        exit 1
    }
}
else {
    Write-Warn "Frontend .env not found (will be created on first use)"
}

# Check infrastructure required vars
if (Test-Path $InfraEnv) {
    $InfraCheck = Read-EnvVar $InfraEnv "JWT_SECRET"
    if (Test-Secret $InfraCheck) {
        Write-Success "Infrastructure JWT_SECRET is valid"
    }
    else {
        Write-Error "Infrastructure JWT_SECRET is invalid or missing"
        exit 1
    }
}
else {
    Write-Warn "Infrastructure .env not found (will be created on first use)"
}

# Verify synchronization
if ((Test-Path $FrontendEnv) -and (Test-Path $InfraEnv)) {
    $FeSecret = Read-EnvVar $FrontendEnv "VITE_JWT_SECRET"
    $InfraSecretCheck = Read-EnvVar $InfraEnv "JWT_SECRET"
    if ($FeSecret -eq $InfraSecretCheck) {
        Write-Success "✓ JWT secrets are synchronized"
    }
    else {
        Write-Error "JWT secrets are NOT synchronized!"
        exit 1
    }
}

# ──────────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host "Environment Setup Complete" -ForegroundColor Green
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Green
Write-Host ""

if (Test-Path $FrontendEnv) {
    Write-Host "Frontend:        $FrontendEnv" -ForegroundColor Cyan
    $feSecret = Read-EnvVar $FrontendEnv "VITE_JWT_SECRET"
    Write-Host "  VITE_JWT_SECRET: $($feSecret.Substring(0, 16))..." -ForegroundColor Yellow
}

if (Test-Path $InfraEnv) {
    Write-Host "Infrastructure:  $InfraEnv" -ForegroundColor Cyan
    $infSecret = Read-EnvVar $InfraEnv "JWT_SECRET"
    Write-Host "  JWT_SECRET:     $($infSecret.Substring(0, 16))..." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "⚠  Important Reminders:" -ForegroundColor Yellow
Write-Host "   • NEVER commit .env files to git"
Write-Host "   • NEVER share secrets with others"
Write-Host "   • Rotate secrets regularly in production"
Write-Host "   • Keep .env files in sync between frontend and backend"
Write-Host ""

if (-not $Prod -and -not $SyncOnly) {
    Write-Host "Next Steps:" -ForegroundColor Cyan
    if (Test-Path $FrontendEnv) {
        Write-Host "   1. cd frontend && npm install"
    }
    Write-Host "   2. Start your services"
    Write-Host "   3. Test that authentication works"
    Write-Host ""
}

Write-Success "All done!"
