#!/bin/bash
#
# setup-env.sh - Environment & Secrets Management Script
# Automatically configures .env files and synchronizes JWT secrets
#
# Usage:
#   ./scripts/setup-env.sh [--prod] [--sync-only] [--no-backup]
#
# Options:
#   --prod          Production mode (requires all variables)
#   --sync-only     Only sync secrets, don't create new .env files
#   --no-backup     Don't backup existing .env files
#   -h, --help      Show this help message
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$PROJECT_ROOT/frontend"
INFRA_DIR="$PROJECT_ROOT/infrastructure"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Flags
PROD_MODE=false
SYNC_ONLY=false
NO_BACKUP=false

# ──────────────────────────────────────────────────────────────────────────────
# Helper Functions
# ──────────────────────────────────────────────────────────────────────────────

log() {
    echo -e "${BLUE}[setup-env]${NC} $*"
}

success() {
    echo -e "${GREEN}✓${NC} $*"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $*"
}

error() {
    echo -e "${RED}✗${NC} $*" >&2
}

die() {
    error "$*"
    exit 1
}

show_help() {
    sed -n '2,/^$/p' "$0" | sed 's/^# //'
    exit 0
}

# Check if command exists
command_exists() {
    command -v "$1" &>/dev/null
}

# Generate 64-char hex secret
generate_secret() {
    openssl rand -hex 32
}

# Validate secret format (64-char hex)
validate_secret() {
    local secret="$1"
    if [[ $secret =~ ^[0-9a-f]{64}$ ]]; then
        return 0
    else
        return 1
    fi
}

# Read env variable from file
read_env_var() {
    local file="$1"
    local var="$2"
    grep "^${var}=" "$file" 2>/dev/null | cut -d= -f2 || echo ""
}

# Write env variable to file
write_env_var() {
    local file="$1"
    local var="$2"
    local value="$3"

    if grep -q "^${var}=" "$file"; then
        # macOS and Linux compatible sed
        sed -i.bak "s|^${var}=.*|${var}=${value}|g" "$file"
        rm -f "${file}.bak"
    else
        echo "${var}=${value}" >> "$file"
    fi
}

# Normalize IMAGE_PREFIX legacy placeholder
normalize_image_prefix() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        return 0
    fi

    local image_prefix
    image_prefix=$(read_env_var "$file" "IMAGE_PREFIX")

    if [[ "$image_prefix" == "your-github-org/canari" ]]; then
        warn "Legacy IMAGE_PREFIX detected in $(basename "$file"), updating to emse-students/canari"
        write_env_var "$file" "IMAGE_PREFIX" "emse-students/canari"
        success "IMAGE_PREFIX migrated to emse-students/canari"
    fi
}

# Backup file if it exists
backup_if_exists() {
    local file="$1"
    if [[ -f "$file" && "$NO_BACKUP" == "false" ]]; then
        local backup="${file}.backup.$(date +%s)"
        cp "$file" "$backup"
        echo "$backup"
    fi
}

# ──────────────────────────────────────────────────────────────────────────────
# Main Logic
# ──────────────────────────────────────────────────────────────────────────────

main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --prod)
                PROD_MODE=true
                shift
                ;;
            --sync-only)
                SYNC_ONLY=true
                shift
                ;;
            --no-backup)
                NO_BACKUP=true
                shift
                ;;
            -h | --help)
                show_help
                ;;
            *)
                error "Unknown option: $1"
                show_help
                ;;
        esac
    done

    log "Environment Setup Script"
    log "Project: $PROJECT_ROOT"

    # Check prerequisites
    log "Checking prerequisites..."
    command_exists openssl || die "OpenSSL not found. Install it and try again."
    success "OpenSSL found: $(openssl version)"

    # ──────────────────────────────────────────────────────────────────────────
    # Frontend Setup
    # ──────────────────────────────────────────────────────────────────────────
    log "Setting up frontend environment..."

    local frontend_env="$FRONTEND_DIR/.env"
    local frontend_example="$FRONTEND_DIR/.env.example"

    if [[ ! -f "$frontend_example" ]]; then
        die "Frontend .env.example not found at $frontend_example"
    fi

    if [[ ! -f "$frontend_env" && "$SYNC_ONLY" == "false" ]]; then
        log "Creating $frontend_env from .env.example..."
        backup_if_exists "$frontend_env"
        cp "$frontend_example" "$frontend_env"
        success "Frontend .env created"
    elif [[ -f "$frontend_env" ]]; then
        success "Frontend .env already exists"
    fi

    # ──────────────────────────────────────────────────────────────────────────
    # Infrastructure Setup
    # ──────────────────────────────────────────────────────────────────────────
    log "Setting up infrastructure environment..."

    local infra_env="$INFRA_DIR/.env"
    local infra_example="$INFRA_DIR/.env.example"

    if [[ ! -f "$infra_example" ]]; then
        die "Infrastructure .env.example not found at $infra_example"
    fi

    if [[ ! -f "$infra_env" && "$SYNC_ONLY" == "false" ]]; then
        log "Creating $infra_env from .env.example..."
        backup_if_exists "$infra_env"
        cp "$infra_example" "$infra_env"
        success "Infrastructure .env created"
    elif [[ -f "$infra_env" ]]; then
        success "Infrastructure .env already exists"
    fi

    # Migrate legacy placeholders in infrastructure env
    normalize_image_prefix "$infra_env"

    # ──────────────────────────────────────────────────────────────────────────
    # JWT Secret Synchronization
    # ──────────────────────────────────────────────────────────────────────────
    log "Synchronizing JWT secrets..."

    local frontend_secret=""
    local infra_secret=""

    if [[ -f "$frontend_env" ]]; then
        frontend_secret=$(read_env_var "$frontend_env" "VITE_JWT_SECRET")
    fi

    if [[ -f "$infra_env" ]]; then
        infra_secret=$(read_env_var "$infra_env" "JWT_SECRET")
    fi

    # Check if we need to generate a new secret
    local should_generate=false
    if [[ -z "$frontend_secret" || "$frontend_secret" == "dev_secret_change_me_in_env_file_never_expose" ]]; then
        should_generate=true
    elif ! validate_secret "$frontend_secret"; then
        warn "Frontend secret is not a valid 64-char hex string"
        should_generate=true
    fi

    if [[ "$should_generate" == "true" ]]; then
        if [[ "$PROD_MODE" == "true" ]]; then
            error "Production mode requires a valid JWT_SECRET to be already configured"
            error "Set JWT_SECRET in both .env files and retry with --prod"
            exit 1
        fi

        log "Generating new JWT secret..."
        local new_secret=$(generate_secret)

        if ! validate_secret "$new_secret"; then
            die "Failed to generate valid secret"
        fi

        success "Generated new secret: ${new_secret:0:16}..."
        frontend_secret="$new_secret"
        infra_secret="$new_secret"
    else
        # Secrets exist, check if they're in sync
        if [[ "$frontend_secret" != "$infra_secret" ]]; then
            if [[ "$PROD_MODE" == "false" ]]; then
                log "Frontend and infrastructure secrets don't match, synchronizing..."
                infra_secret="$frontend_secret"
            else
                error "Frontend and infrastructure JWT_SECRET don't match!"
                error "Frontend: ${frontend_secret:0:16}..."
                error "Infrastructure: ${infra_secret:0:16}..."
                error "In production, they MUST be identical"
                exit 1
            fi
        fi
    fi

    # Write secrets to files
    if [[ -f "$frontend_env" ]]; then
        write_env_var "$frontend_env" "VITE_JWT_SECRET" "$frontend_secret"
        success "Updated frontend VITE_JWT_SECRET"
    fi

    if [[ -f "$infra_env" ]]; then
        write_env_var "$infra_env" "JWT_SECRET" "$infra_secret"
        success "Updated infrastructure JWT_SECRET"
    fi

    # ──────────────────────────────────────────────────────────────────────────
    # Validation
    # ──────────────────────────────────────────────────────────────────────────
    log "Validating configuration..."

    # Check frontend required vars
    if [[ -f "$frontend_env" ]]; then
        local frontend_check=$(read_env_var "$frontend_env" "VITE_JWT_SECRET")
        if validate_secret "$frontend_check"; then
            success "Frontend VITE_JWT_SECRET is valid"
        else
            error "Frontend VITE_JWT_SECRET is invalid or missing"
            exit 1
        fi
    else
        warn "Frontend .env not found (will be created on first use)"
    fi

    # Check infrastructure required vars
    if [[ -f "$infra_env" ]]; then
        local infra_check=$(read_env_var "$infra_env" "JWT_SECRET")
        if validate_secret "$infra_check"; then
            success "Infrastructure JWT_SECRET is valid"
        else
            error "Infrastructure JWT_SECRET is invalid or missing"
            exit 1
        fi
    else
        warn "Infrastructure .env not found (will be created on first use)"
    fi

    # Verify synchronization
    if [[ -f "$frontend_env" && -f "$infra_env" ]]; then
        local fe_secret=$(read_env_var "$frontend_env" "VITE_JWT_SECRET")
        local infra_secret_check=$(read_env_var "$infra_env" "JWT_SECRET")
        if [[ "$fe_secret" == "$infra_secret_check" ]]; then
            success "✓ JWT secrets are synchronized"
        else
            error "JWT secrets are NOT synchronized!"
            exit 1
        fi
    fi

    # ──────────────────────────────────────────────────────────────────────────
    # Summary
    # ──────────────────────────────────────────────────────────────────────────
    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}Environment Setup Complete${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo ""

    if [[ -f "$frontend_env" ]]; then
        echo -e "Frontend:        ${BLUE}$frontend_env${NC}"
        echo -e "  VITE_JWT_SECRET: ${YELLOW}${frontend_secret:0:16}...${NC}"
    fi

    if [[ -f "$infra_env" ]]; then
        echo -e "Infrastructure:  ${BLUE}$infra_env${NC}"
        echo -e "  JWT_SECRET:     ${YELLOW}${infra_secret:0:16}...${NC}"
    fi

    echo ""
    echo -e "${YELLOW}⚠  Important Reminders:${NC}"
    echo "   • NEVER commit .env files to git"
    echo "   • NEVER share secrets with others"
    echo "   • Rotate secrets regularly in production"
    echo "   • Keep .env files in sync between frontend and backend"
    echo ""

    if [[ "$PROD_MODE" == "false" && "$SYNC_ONLY" == "false" ]]; then
        echo -e "${BLUE}Next Steps:${NC}"
        if [[ -f "$frontend_env" ]]; then
            echo "   1. cd frontend && npm install"
        fi
        echo "   2. Start your services"
        echo "   3. Test that authentication works"
        echo ""
    fi

    success "All done!"
}

# ──────────────────────────────────────────────────────────────────────────────
# Entry Point
# ──────────────────────────────────────────────────────────────────────────────

main "$@"
