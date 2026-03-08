# Environment Setup Scripts

Automated scripts to manage `.env` files and JWT secrets across the project.

## Quick Start

### Linux/macOS (Recommended for servers)

```bash
# Make script executable
chmod +x scripts/setup-env.sh

# Development: Create .env files and generate secrets
./scripts/setup-env.sh

# Production: Sync existing secrets (requires .env files to exist)
./scripts/setup-env.sh --prod --sync-only

# Sync without creating new files
./scripts/setup-env.sh --sync-only
```

### Windows (PowerShell)

```powershell
# Allow script execution
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# Development: Create .env files and generate secrets
.\scripts\setup-env.ps1

# Production: Sync existing secrets
.\scripts\setup-env.ps1 -Prod -SyncOnly

# Sync only
.\scripts\setup-env.ps1 -SyncOnly
```

## What the Scripts Do

### Initialization Mode (Default)
1. ✓ Creates `frontend/.env` from `frontend/.env.example` (if missing)
2. ✓ Creates `infrastructure/.env` from `infrastructure/.env.example` (if missing)
3. ✓ Generates a new 64-character hex JWT secret
4. ✓ Synchronizes JWT_SECRET between frontend and backend
5. ✓ Validates all configuration

### Sync-Only Mode (`--sync-only`)
When running on a server with existing `.env` files:
- Only synchronizes secrets between files
- Does NOT create new `.env` files
- Fails if secrets are out of sync (with `--prod` flag)

## Environment Variables

### Frontend (`frontend/.env`)
```env
VITE_JWT_SECRET=<64-char-hex>    # Required: JWT signing secret
VITE_GATEWAY_URL=                 # Optional: Backend URL (leaves empty for production)
VITE_HISTORY_URL=                 # Optional: History URL
```

### Infrastructure (`infrastructure/.env`)
```env
JWT_SECRET=<64-char-hex>          # Required: Must match frontend VITE_JWT_SECRET
POSTGRES_USER=admin
POSTGRES_PASSWORD=<strong-password>
POSTGRES_DB=auth_db
DOMAIN=canari-emse.fr
ALLOW_ORIGIN=https://canari-emse.fr
REGISTRY=ghcr.io
IMAGE_PREFIX=your-github-org/canari
TAG=latest
RUST_LOG=chat_gateway=info,tower_http=info
NODE_ENV=production
GATEWAY_PORT=3000
DELIVERY_PORT=3001
```

## Production Deployment

When deploying to production:

### 1. On Development Machine (Before Deployment)
```bash
# Prepare the .env files locally
./scripts/setup-env.sh

# Copy infrastructure/.env to your secure location
# (Never commit to git!)
```

### 2. On Production Server
```bash
# Copy infrastructure/.env to the server (via secure channel)
# E.g., scp infrastructure/.env deploy@server:/path/to/canari/infrastructure/

# Run setup script to validate and sync
ssh deploy@server
cd /path/to/canari
./scripts/setup-env.sh --prod --sync-only

# Should show: "✓ JWT secrets are synchronized"
```

### 3. Build and Deploy
```bash
# Frontend build with injected secret
export VITE_JWT_SECRET=$(grep JWT_SECRET infrastructure/.env | cut -d= -f2)
npm run build  # Vite embeds the secret at build time

# Backend services read JWT_SECRET at runtime
docker compose up -d
```

## Options

### `--prod` (Production Mode)
- Strict validation: all secrets must be pre-configured
- Will not generate new secrets
- Requires JWT_SECRET to match between all files
- Recommended for production deployments

### `--sync-only`
- Only synchronizes existing secrets
- Does NOT create new `.env` files
- Useful for syncing changes across environment files
- Use with `--prod` for production validation

### `--no-backup`
- Skip creating backup files when overwriting existing `.env`
- By default, backups are created as `.env.backup_<timestamp>`

## Troubleshooting

### "OpenSSL not found"
Install OpenSSL:
```bash
# macOS
brew install openssl

# Ubuntu/Debian
sudo apt-get install openssl

# Windows
choco install openssl
# or use official installer from openssl.org
```

### "Frontend and infrastructure JWT_SECRET don't match"
The secrets in `frontend/.env` and `infrastructure/.env` are different.
```bash
# In development, re-run the script to sync:
./scripts/setup-env.sh

# In production, check which value is correct and manually sync:
cd infrastructure
grep JWT_SECRET .env  # Get the value

cd ../frontend
# Edit .env and set VITE_JWT_SECRET to match
```

### "JWT_SECRET not configured"
Set the variable in both `.env` files:
```bash
# Generate a new secret
openssl rand -hex 32

# Add to both files
echo "VITE_JWT_SECRET=<generated-value>" >> frontend/.env
echo "JWT_SECRET=<generated-value>" >> infrastructure/.env
```

## Security Best Practices

⚠️ **CRITICAL:**
1. **Never commit `.env` files** - they're in `.gitignore` for a reason
2. **Never share secrets** in chat, email, or public channels
3. **Use strong, unique secrets** for each environment
4. **Rotate secrets regularly** - especially if exposed
5. **Keep frontend and backend secrets in sync** - token validation depends on it

## Integration with CI/CD

### GitHub Actions
```yaml
- name: Setup environment
  run: |
    chmod +x scripts/setup-env.sh
    ./scripts/setup-env.sh --sync-only
  env:
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
```

### GitLab CI
```yaml
setup_env:
  script:
    - chmod +x scripts/setup-env.sh
    - ./scripts/setup-env.sh --sync-only
  variables:
    JWT_SECRET: $CI_JOB_TOKEN  # or use protected variable
```

## Manual Alternative

If the scripts don't work, you can manually set up `.env` files:

```bash
# Frontend
cp frontend/.env.example frontend/.env
echo "VITE_JWT_SECRET=$(openssl rand -hex 32)" >> frontend/.env

# Backend
cp infrastructure/.env.example infrastructure/.env
# Edit infrastructure/.env and set same JWT_SECRET
```

Then verify:
```bash
# Should output the same value for both
grep VITE_JWT_SECRET frontend/.env | cut -d= -f2
grep JWT_SECRET infrastructure/.env | cut -d= -f2
```
