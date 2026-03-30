#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Canari — Authentik OIDC Configuration Checker
# Usage:  bash scripts/check-oidc.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
WARN=0
FAIL=0

pass()  { PASS=$((PASS+1)); echo -e "  ${GREEN}✔${NC} $1"; }
warn()  { WARN=$((WARN+1)); echo -e "  ${YELLOW}⚠${NC} $1"; }
fail()  { FAIL=$((FAIL+1)); echo -e "  ${RED}✗${NC} $1"; }
header(){ echo -e "\n${CYAN}${BOLD}── $1 ──${NC}"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ═════════════════════════════════════════════════════════════════════════════
# 1. Backend env vars (core-service)
# ═════════════════════════════════════════════════════════════════════════════
header "Backend environment variables (core-service)"

# Source .env if it exists
CORE_ENV="$ROOT/apps/core-service/.env"
if [[ -f "$CORE_ENV" ]]; then
  pass "Found $CORE_ENV"
  set -a; source "$CORE_ENV" 2>/dev/null || true; set +a
else
  # Also check if vars are already exported (e.g. from docker-compose or shell)
  if [[ -z "${AUTHENTIK_BASE_URL:-}" ]]; then
    warn "No apps/core-service/.env found — checking exported env vars"
  fi
fi

# AUTHENTIK_BASE_URL
if [[ -n "${AUTHENTIK_BASE_URL:-}" ]]; then
  # Strip trailing slashes for display
  AURL="${AUTHENTIK_BASE_URL%/}"
  pass "AUTHENTIK_BASE_URL = ${AURL}"
else
  fail "AUTHENTIK_BASE_URL is not set"
  AURL=""
fi

# AUTHENTIK_CLIENT_ID
if [[ -n "${AUTHENTIK_CLIENT_ID:-}" ]]; then
  pass "AUTHENTIK_CLIENT_ID = ${AUTHENTIK_CLIENT_ID:0:8}…"
else
  fail "AUTHENTIK_CLIENT_ID is not set"
fi

# AUTHENTIK_CLIENT_SECRET
if [[ -n "${AUTHENTIK_CLIENT_SECRET:-}" ]]; then
  pass "AUTHENTIK_CLIENT_SECRET = ${AUTHENTIK_CLIENT_SECRET:0:4}••••"
else
  fail "AUTHENTIK_CLIENT_SECRET is not set"
fi

# JWT_SECRET
if [[ -n "${JWT_SECRET:-}" ]]; then
  if [[ "$JWT_SECRET" == "change-me-in-production" || "$JWT_SECRET" == "your-secret-jwt-key-here-change-me" ]]; then
    fail "JWT_SECRET is still set to a placeholder value"
  elif [[ ${#JWT_SECRET} -lt 32 ]]; then
    warn "JWT_SECRET is short (${#JWT_SECRET} chars) — recommended ≥ 32"
  else
    pass "JWT_SECRET is set (${#JWT_SECRET} chars)"
  fi
else
  fail "JWT_SECRET is not set"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 2. Frontend env vars
# ═════════════════════════════════════════════════════════════════════════════
header "Frontend environment variables"

FE_ENV="$ROOT/frontend/.env"
if [[ -f "$FE_ENV" ]]; then
  pass "Found $FE_ENV"
else
  FE_ENV="$ROOT/frontend/.env.local"
  if [[ -f "$FE_ENV" ]]; then
    pass "Found $FE_ENV"
  else
    fail "No frontend/.env or .env.local found"
    FE_ENV=""
  fi
fi

if [[ -n "$FE_ENV" ]]; then
  VITE_AUTHENTIK_URL=$(grep -E '^VITE_AUTHENTIK_URL=' "$FE_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'\"" || true)
  VITE_AUTHENTIK_CLIENT_ID=$(grep -E '^VITE_AUTHENTIK_CLIENT_ID=' "$FE_ENV" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'\"" || true)

  if [[ -n "$VITE_AUTHENTIK_URL" ]]; then
    pass "VITE_AUTHENTIK_URL = $VITE_AUTHENTIK_URL"
  else
    fail "VITE_AUTHENTIK_URL is not set in $FE_ENV"
  fi

  if [[ -n "$VITE_AUTHENTIK_CLIENT_ID" ]]; then
    pass "VITE_AUTHENTIK_CLIENT_ID = ${VITE_AUTHENTIK_CLIENT_ID:0:8}…"
  else
    fail "VITE_AUTHENTIK_CLIENT_ID is not set in $FE_ENV"
  fi

  # Cross-check: client IDs should match
  if [[ -n "${AUTHENTIK_CLIENT_ID:-}" && -n "$VITE_AUTHENTIK_CLIENT_ID" ]]; then
    if [[ "$AUTHENTIK_CLIENT_ID" == "$VITE_AUTHENTIK_CLIENT_ID" ]]; then
      pass "Client IDs match between backend and frontend"
    else
      fail "Client ID mismatch! Backend='${AUTHENTIK_CLIENT_ID:0:8}…' Frontend='${VITE_AUTHENTIK_CLIENT_ID:0:8}…'"
    fi
  fi

  # Cross-check: base URLs should match
  if [[ -n "$AURL" && -n "$VITE_AUTHENTIK_URL" ]]; then
    FE_URL="${VITE_AUTHENTIK_URL%/}"
    if [[ "$AURL" == "$FE_URL" ]]; then
      pass "Authentik URLs match between backend and frontend"
    else
      fail "Authentik URL mismatch! Backend='$AURL' Frontend='$FE_URL'"
    fi
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# 3. Authentik connectivity
# ═════════════════════════════════════════════════════════════════════════════
header "Authentik server connectivity"

# Use the frontend URL as fallback if backend URL is not set
CHECK_URL="${AURL:-${VITE_AUTHENTIK_URL:-}}"
CHECK_URL="${CHECK_URL%/}"

if [[ -z "$CHECK_URL" ]]; then
  fail "Cannot test connectivity — no Authentik URL configured"
else
  # 3a. OpenID Discovery endpoint
  DISCO_URL="$CHECK_URL/application/o/canari/.well-known/openid-configuration"
  echo -e "  Checking discovery: ${CYAN}$DISCO_URL${NC}"

  HTTP_CODE=$(curl -s -o /tmp/canari_oidc_disco.json -w "%{http_code}" \
    --connect-timeout 5 --max-time 10 "$DISCO_URL" 2>/dev/null || echo "000")

  if [[ "$HTTP_CODE" == "200" ]]; then
    pass "OpenID discovery endpoint reachable (HTTP 200)"
    # Parse key fields
    ISSUER=$(jq -r '.issuer // empty' /tmp/canari_oidc_disco.json 2>/dev/null || true)
    AUTH_EP=$(jq -r '.authorization_endpoint // empty' /tmp/canari_oidc_disco.json 2>/dev/null || true)
    TOKEN_EP=$(jq -r '.token_endpoint // empty' /tmp/canari_oidc_disco.json 2>/dev/null || true)
    USERINFO_EP=$(jq -r '.userinfo_endpoint // empty' /tmp/canari_oidc_disco.json 2>/dev/null || true)

    [[ -n "$ISSUER" ]]      && pass "  issuer = $ISSUER"                || warn "  issuer missing"
    [[ -n "$AUTH_EP" ]]      && pass "  authorization_endpoint OK"       || warn "  authorization_endpoint missing"
    [[ -n "$TOKEN_EP" ]]     && pass "  token_endpoint OK"               || warn "  token_endpoint missing"
    [[ -n "$USERINFO_EP" ]]  && pass "  userinfo_endpoint OK"            || warn "  userinfo_endpoint missing"

    # Check supported scopes
    SCOPES=$(jq -r '.scopes_supported // [] | join(" ")' /tmp/canari_oidc_disco.json 2>/dev/null || true)
    for S in openid profile email; do
      if echo "$SCOPES" | grep -qw "$S"; then
        pass "  scope '$S' supported"
      else
        warn "  scope '$S' not listed (may still work)"
      fi
    done
  elif [[ "$HTTP_CODE" == "000" ]]; then
    fail "Cannot reach Authentik at $CHECK_URL (connection refused / timeout)"
    echo -e "     ${YELLOW}→ Is Authentik running? Check the URL and firewall.${NC}"
  elif [[ "$HTTP_CODE" == "404" ]]; then
    warn "Discovery returned 404 — the application slug might not be 'canari'"
    echo -e "     ${YELLOW}→ Trying generic well-known at provider level...${NC}"
    # Try the base /.well-known/openid-configuration
    GENERIC_URL="$CHECK_URL/.well-known/openid-configuration"
    GEN_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$GENERIC_URL" 2>/dev/null || echo "000")
    if [[ "$GEN_CODE" == "200" ]]; then
      pass "Base discovery works at $GENERIC_URL — adjust the app slug in the check script if needed"
    else
      fail "Base discovery also failed (HTTP $GEN_CODE)"
    fi
  else
    fail "Discovery returned HTTP $HTTP_CODE"
  fi

  # 3b. Authorize endpoint (just check it doesn't 5xx)
  AUTH_TEST_URL="$CHECK_URL/application/o/authorize/"
  echo -e "  Checking authorize: ${CYAN}$AUTH_TEST_URL${NC}"
  AUTH_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout 5 --max-time 10 "$AUTH_TEST_URL" 2>/dev/null || echo "000")
  if [[ "$AUTH_CODE" =~ ^(200|302|303|400|401|403)$ ]]; then
    pass "Authorize endpoint reachable (HTTP $AUTH_CODE — expected redirect or 400 without params)"
  elif [[ "$AUTH_CODE" == "000" ]]; then
    fail "Cannot reach authorize endpoint"
  else
    warn "Authorize endpoint returned HTTP $AUTH_CODE"
  fi

  # 3c. Token endpoint (just check reachability)
  TOKEN_TEST_URL="$CHECK_URL/application/o/token/"
  echo -e "  Checking token: ${CYAN}$TOKEN_TEST_URL${NC}"
  TOK_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    --connect-timeout 5 --max-time 10 -X POST "$TOKEN_TEST_URL" 2>/dev/null || echo "000")
  if [[ "$TOK_CODE" =~ ^(200|400|401|403|405|415)$ ]]; then
    pass "Token endpoint reachable (HTTP $TOK_CODE — expected 400 without body)"
  elif [[ "$TOK_CODE" == "000" ]]; then
    fail "Cannot reach token endpoint"
  else
    warn "Token endpoint returned HTTP $TOK_CODE"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# 4. Core-service reachability
# ═════════════════════════════════════════════════════════════════════════════
header "Core-service (localhost:3012)"

CORE_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  --connect-timeout 3 --max-time 5 "http://localhost:3012/auth/verify" 2>/dev/null || echo "000")

if [[ "$CORE_CODE" == "200" ]]; then
  pass "core-service /auth/verify responding (HTTP 200)"
elif [[ "$CORE_CODE" == "000" ]]; then
  warn "core-service not running on localhost:3012 (start it to test the full flow)"
else
  warn "core-service returned HTTP $CORE_CODE on /auth/verify"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 5. Callback route exists in frontend
# ═════════════════════════════════════════════════════════════════════════════
header "Frontend callback route"

CALLBACK_FILE="$ROOT/frontend/src/routes/auth/callback/+page.svelte"
if [[ -f "$CALLBACK_FILE" ]]; then
  pass "Callback page exists: src/routes/auth/callback/+page.svelte"
  if grep -q 'handleOidcCallback' "$CALLBACK_FILE"; then
    pass "handleOidcCallback is called in the callback page"
  else
    fail "handleOidcCallback not found in callback page"
  fi
else
  fail "Missing: frontend/src/routes/auth/callback/+page.svelte"
fi

# ═════════════════════════════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"
echo -e "  ${GREEN}✔ $PASS passed${NC}   ${YELLOW}⚠ $WARN warnings${NC}   ${RED}✗ $FAIL failed${NC}"
echo -e "${BOLD}═══════════════════════════════════════════════════${NC}"

if [[ $FAIL -gt 0 ]]; then
  echo -e "\n${RED}${BOLD}Configuration incomplete.${NC} Fix the failed checks above."
  echo -e "Need help? Re-read the Authentik config guide or ask me with the output of this script."
  exit 1
elif [[ $WARN -gt 0 ]]; then
  echo -e "\n${YELLOW}${BOLD}Configuration looks OK with minor warnings.${NC}"
  exit 0
else
  echo -e "\n${GREEN}${BOLD}All checks passed! OIDC is ready.${NC}"
  exit 0
fi
