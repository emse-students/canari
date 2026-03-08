#!/bin/bash
#
# setup-env.sh — Initialisation des fichiers .env
#
# Usage:
#   ./scripts/setup-env.sh          # Développement : crée frontend/.env + infrastructure/.env
#   ./scripts/setup-env.sh --prod   # Production    : crée uniquement infrastructure/.env
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
INFRA_ENV="$ROOT/infrastructure/.env"
FRONTEND_ENV="$ROOT/frontend/.env"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${BLUE}→${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*" >&2; exit 1; }

PROD=false
[[ "${1:-}" == "--prod" ]] && PROD=true

command -v openssl >/dev/null || die "openssl requis (apt install openssl)"

# ── infrastructure/.env ────────────────────────────────────────────────────────
if [[ ! -f "$INFRA_ENV" ]]; then
    info "Création de infrastructure/.env depuis le template..."
    cp "$ROOT/infrastructure/.env.example" "$INFRA_ENV"
fi

# Générer JWT_SECRET si manquant ou valeur par défaut
CURRENT=$(grep -E '^JWT_SECRET=' "$INFRA_ENV" | cut -d= -f2 || true)
if [[ -z "$CURRENT" || "$CURRENT" == "your-secret-jwt-key-here-change-me" ]]; then
    SECRET=$(openssl rand -hex 32)
    sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" "$INFRA_ENV" && rm -f "${INFRA_ENV}.bak"
    ok "JWT_SECRET généré dans infrastructure/.env"
else
    ok "JWT_SECRET déjà configuré dans infrastructure/.env"
fi

JWT_SECRET=$(grep -E '^JWT_SECRET=' "$INFRA_ENV" | cut -d= -f2)

# ── frontend/.env (dev uniquement) ────────────────────────────────────────────
if [[ "$PROD" == "false" ]]; then
    if [[ ! -f "$FRONTEND_ENV" ]]; then
        info "Création de frontend/.env depuis le template..."
        cp "$ROOT/frontend/.env.example" "$FRONTEND_ENV"
    fi
    sed -i.bak "s|^VITE_JWT_SECRET=.*|VITE_JWT_SECRET=${JWT_SECRET}|" "$FRONTEND_ENV" && rm -f "${FRONTEND_ENV}.bak"
    ok "VITE_JWT_SECRET synchronisé dans frontend/.env (dev local)"
else
    warn "Mode --prod : frontend/.env ignoré (VITE_JWT_SECRET est injecté par le CI via GitHub Secrets)"
fi

# ── Résumé ────────────────────────────────────────────────────────────────────
echo ""
echo "infrastructure/.env → JWT_SECRET: ${JWT_SECRET:0:16}..."
if [[ "$PROD" == "false" ]]; then
    echo "frontend/.env      → VITE_JWT_SECRET: ${JWT_SECRET:0:16}..."
    echo ""
    echo "Prochaines étapes :"
    echo "  make install"
    echo "  make run-services && cd frontend && bun run dev"
else
    echo ""
    warn "Copiez la valeur de JWT_SECRET dans GitHub Secrets (Settings → Secrets → JWT_SECRET)"
    warn "pour que le CI puisse builder le frontend avec la bonne clé."
fi
