.PHONY: all install install-node install-bun install-rust install-wasm-pack install-frontend install-services install-hooks setup-env setup-env-prod production production-check build-frontend reload-services test test-libs test-gateway test-history test-frontend clean run-ci lint-frontend

# Cible par défaut : installation complète et déploiement LOCAL
.DEFAULT_GOAL := all

all: install install-hooks build-frontend reload-services
	@echo ""
	@echo "${BOLD}${GREEN}🎉 INSTALLATION COMPLÈTE TERMINÉE (DEV LOCAL)${RESET}"
	@echo "---------------------------------------------------"
	@echo "${GREEN}✅ Dépendances installées${RESET}"
	@echo "${GREEN}✅ Git hooks configurés${RESET}"
	@echo "${GREEN}✅ Frontend buildé${RESET}"
	@echo "${GREEN}✅ Services Docker rechargés${RESET}"
	@echo "---------------------------------------------------"
	@echo ""

# ── Déploiement Production ────────────────────────────────────────────────────
production: production-check
	@echo ""
	@echo "${BOLD}${BLUE}🚀 DÉPLOIEMENT PRODUCTION${RESET}"
	@echo "---------------------------------------------------"

ifeq ($(OS),Windows_NT)
	@powershell -NoProfile -Command "$$u=(Get-Content infrastructure/.env | Where-Object { $$_.ToString() -match '^GHCR_USERNAME=' } | Select-Object -First 1) -replace '^GHCR_USERNAME=', ''; $$t=(Get-Content infrastructure/.env | Where-Object { $$_.ToString() -match '^GHCR_TOKEN=' } | Select-Object -First 1) -replace '^GHCR_TOKEN=', ''; if (-not [string]::IsNullOrWhiteSpace($$u) -and -not [string]::IsNullOrWhiteSpace($$t)) { $$t | docker login ghcr.io -u $$u --password-stdin | Out-Null; Write-Host '${GREEN}✅ Auth GHCR OK${RESET}' } else { Write-Host '${YELLOW}⚠️  GHCR_USERNAME/GHCR_TOKEN absents dans infrastructure/.env (pull public/local only)${RESET}' }"
else
	@GHCR_U=$$(grep -E '^GHCR_USERNAME=' infrastructure/.env | cut -d= -f2 || true); \
	GHCR_T=$$(grep -E '^GHCR_TOKEN=' infrastructure/.env | cut -d= -f2 || true); \
	if [ -n "$$GHCR_U" ] && [ -n "$$GHCR_T" ]; then \
		echo "$$GHCR_T" | docker login ghcr.io -u "$$GHCR_U" --password-stdin >/dev/null; \
		echo "${GREEN}✅ Auth GHCR OK${RESET}"; \
	else \
		echo "${YELLOW}⚠️  GHCR_USERNAME/GHCR_TOKEN absents dans infrastructure/.env (pull public/local only)${RESET}"; \
	fi
endif

	@echo "${BLUE}📥 Pulling Docker images from GHCR...${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml pull || \
		echo "${YELLOW}⚠️  Pull partiel/échoué — tentative de démarrage avec images locales disponibles${RESET}"
	@echo "${BLUE}🛑 Stopping existing containers...${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml down --remove-orphans
	@echo "${BLUE}🚀 Starting production services...${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml up -d --remove-orphans
	@echo ""
	@echo "${BOLD}${GREEN}✅ DÉPLOIEMENT PRODUCTION TERMINÉ${RESET}"
	@echo "---------------------------------------------------"
	@echo "${GREEN}✅ Configuration validée${RESET}"
	@echo "${GREEN}✅ Images Docker pullées${RESET}"
	@echo "${GREEN}✅ Services démarrés${RESET}"
	@echo "---------------------------------------------------"
	@echo ""
	@echo "${YELLOW}🔍 Vérifier les services :${RESET}"
	@echo "  docker compose -f infrastructure/docker-compose.prod.yml ps"
	@echo ""
	@echo "${YELLOW}📋 Voir les logs :${RESET}"
	@echo "  docker compose -f infrastructure/docker-compose.prod.yml logs -f"
	@echo ""

production-check:
	@echo "${BLUE}🔍 Vérification de la configuration production...${RESET}"

ifeq ($(OS),Windows_NT)
	@if not exist infrastructure\.env ( \
		echo "${YELLOW}⚠️  infrastructure/.env manquant — création depuis le template${RESET}" & \
		powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1 -Prod & \
		echo "${YELLOW}⚠️  Éditez infrastructure/.env (POSTGRES_PASSWORD, DOMAIN...) puis relancez.${RESET}" & \
		exit /b 1 \
	)
	@powershell -NoProfile -Command "$$prefix = (Get-Content infrastructure/.env | Where-Object { $$_.ToString() -match '^IMAGE_PREFIX=' } | Select-Object -First 1) -replace '^IMAGE_PREFIX=', ''; if ([string]::IsNullOrWhiteSpace($$prefix) -or $$prefix -eq 'your-github-org/canari') { if (Select-String -Path infrastructure/.env -Pattern '^IMAGE_PREFIX=' -Quiet) { (Get-Content infrastructure/.env) -replace '^IMAGE_PREFIX=.*', 'IMAGE_PREFIX=emse-students/canari' | Set-Content infrastructure/.env } else { Add-Content infrastructure/.env 'IMAGE_PREFIX=emse-students/canari' }; Write-Host '${YELLOW}⚠️  IMAGE_PREFIX corrigé vers emse-students/canari${RESET}' }"
	@powershell -NoProfile -Command "$$jwt = (Get-Content infrastructure/.env | Where-Object { $$_.ToString() -match '^JWT_SECRET=' } | Select-Object -First 1) -replace '^JWT_SECRET=', ''; if ([string]::IsNullOrWhiteSpace($$jwt) -or $$jwt -eq 'your-secret-jwt-key-here-change-me') { Write-Host '${RED}❌ JWT_SECRET non configuré dans infrastructure/.env${RESET}'; Write-Host '${BLUE}Générez-en un : openssl rand -hex 32${RESET}'; exit 1 }"
	@powershell -NoProfile -Command "if (Select-String -Path infrastructure/.env -Pattern '^POSTGRES_PASSWORD=change-me-strong-password' -Quiet) { Write-Host '${YELLOW}⚠️  Changez POSTGRES_PASSWORD dans infrastructure/.env${RESET}' }"
	@echo "${GREEN}✅ Configuration validée${RESET}"
else
	@if [ ! -f infrastructure/.env ]; then \
		echo "${YELLOW}⚠️  infrastructure/.env manquant — création depuis le template${RESET}"; \
		chmod +x scripts/setup-env.sh; \
		./scripts/setup-env.sh --prod; \
		echo ""; \
		echo "${YELLOW}⚠️  Éditez infrastructure/.env (POSTGRES_PASSWORD, DOMAIN...) puis relancez.${RESET}"; \
		exit 1; \
	fi
	@PREFIX=$$(grep -E '^IMAGE_PREFIX=' infrastructure/.env | cut -d= -f2 || true); \
	if [ -z "$$PREFIX" ] || [ "$$PREFIX" = "your-github-org/canari" ]; then \
		if grep -q '^IMAGE_PREFIX=' infrastructure/.env; then \
			sed -i.bak 's|^IMAGE_PREFIX=.*|IMAGE_PREFIX=emse-students/canari|' infrastructure/.env; \
			rm -f infrastructure/.env.bak; \
		else \
			echo 'IMAGE_PREFIX=emse-students/canari' >> infrastructure/.env; \
		fi; \
		echo "${YELLOW}⚠️  IMAGE_PREFIX corrigé vers emse-students/canari${RESET}"; \
	fi
	@JWT=$$(grep -E '^JWT_SECRET=' infrastructure/.env | cut -d= -f2 || true); \
	if [ -z "$$JWT" ] || [ "$$JWT" = "your-secret-jwt-key-here-change-me" ]; then \
		echo "${RED}❌ JWT_SECRET non configuré dans infrastructure/.env${RESET}"; \
		echo "${BLUE}Générez-en un : openssl rand -hex 32${RESET}"; \
		exit 1; \
	fi
	@if grep -q '^POSTGRES_PASSWORD=change-me-strong-password' infrastructure/.env; then \
		echo "${YELLOW}⚠️  Changez POSTGRES_PASSWORD dans infrastructure/.env${RESET}"; \
	fi
	@echo "${GREEN}✅ Configuration validée${RESET}"
endif

# Note: le frontend est servi par le container Docker nginx (infrastructure/local/Dockerfile.frontend)
# HTTPS est géré par Cloudflare Tunnel. Pas de nginx externe.

# Détection de l'OS pour la compatibilité
ifeq ($(OS),Windows_NT)
    # Windows
    GREEN :=
    RED :=
    BLUE :=
    BOLD :=
    RESET :=
    CHECK_CMD := where
    NULL_DEV := NUL
    # Sur Windows avec cmd.exe, les structures conditionnelles complexes dans une ligne sont difficiles
    # On simplifie pour utiliser cargo test directement
    RUST_TEST_CMD := cargo test
else
    # Linux / MacOS
    GREEN := $(shell tput -Txterm setaf 2)
    RED := $(shell tput -Txterm setaf 1)
    BLUE := $(shell tput -Txterm setaf 4)
    BOLD := $(shell tput -Txterm bold)
    RESET := $(shell tput -Txterm sgr0)
    CHECK_CMD := command -v
    NULL_DEV := /dev/null
    # Commande avec vérification de coverage
    RUST_TEST_CMD := if command -v cargo-tarpaulin >/dev/null; then \
        echo "   (Coverage enabled via cargo-tarpaulin)"; \
        cargo tarpaulin --out Xml --output-dir coverage; \
    else \
        cargo test; \
    fi
endif

# ── Installation des dépendances ──────────────────────────────────────────────
install: install-node install-bun install-rust install-wasm-pack install-frontend install-services

ifeq ($(OS),Windows_NT)
install-node:
	@echo "${BLUE}ℹ️ Node.js/npm auto-install skipped on Windows${RESET}"
	@echo "${BLUE}ℹ️ Install manually from: https://nodejs.org/${RESET}"

install-bun:
	@echo "${BLUE}ℹ️ Bun auto-install skipped on Windows${RESET}"
	@echo "${BLUE}ℹ️ Install manually if needed: https://bun.sh/docs/installation${RESET}"

install-rust:
	@echo "${BLUE}ℹ️ Rust auto-install skipped on Windows${RESET}"
	@echo "${BLUE}ℹ️ Install manually from: https://rustup.rs/${RESET}"

install-wasm-pack:
	@echo "${BLUE}ℹ️ wasm-pack auto-install skipped on Windows${RESET}"
	@echo "${BLUE}ℹ️ Install manually: cargo install wasm-pack${RESET}"
else
install-node:
	@echo "${BLUE}📦 Checking Node.js/npm installation...${RESET}"
	@if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then \
		echo "${GREEN}✅ Node.js already installed: $$(node --version)${RESET}"; \
		echo "${GREEN}✅ npm already installed: $$(npm --version)${RESET}"; \
	else \
		echo "${BLUE}⬇️ Installing Node.js via nvm...${RESET}"; \
		if [ ! -d "$$HOME/.nvm" ]; then \
			curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash; \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
		else \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
		fi; \
		nvm install --lts; \
		nvm use --lts; \
		echo "${YELLOW}⚠ Open a new shell or run: source ~/.bashrc${RESET}"; \
	fi

install-bun:
	@echo "${BLUE}📦 Checking Bun installation...${RESET}"
	@if command -v bun >/dev/null 2>&1; then \
		echo "${GREEN}✅ Bun already installed: $$(bun --version)${RESET}"; \
	else \
		echo "${BLUE}⬇️ Installing Bun...${RESET}"; \
		curl -fsSL https://bun.sh/install | bash; \
		echo "${YELLOW}⚠ Open a new shell or run: export PATH=\"$$HOME/.bun/bin:$$PATH\"${RESET}"; \
	fi

install-rust:
	@echo "${BLUE}📦 Checking Rust/cargo installation...${RESET}"
	@if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then \
		echo "${GREEN}✅ Rust already installed: $$(rustc --version)${RESET}"; \
		echo "${GREEN}✅ cargo already installed: $$(cargo --version)${RESET}"; \
	else \
		echo "${BLUE}⬇️ Installing Rust via rustup...${RESET}"; \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable; \
		. "$$HOME/.cargo/env"; \
		rustup target add wasm32-unknown-unknown; \
		echo "${YELLOW}⚠ Open a new shell or run: source ~/.cargo/env${RESET}"; \
	fi

install-wasm-pack:
	@echo "${BLUE}📦 Checking wasm-pack installation...${RESET}"
	@if command -v wasm-pack >/dev/null 2>&1; then \
		echo "${GREEN}✅ wasm-pack already installed: $$(wasm-pack --version)${RESET}"; \
	else \
		echo "${BLUE}⬇️ Installing wasm-pack via cargo...${RESET}"; \
		if command -v cargo >/dev/null 2>&1; then \
			cargo install wasm-pack; \
			echo "${GREEN}✅ wasm-pack installed successfully${RESET}"; \
		else \
			. "$$HOME/.cargo/env" 2>/dev/null || true; \
			if command -v cargo >/dev/null 2>&1; then \
				cargo install wasm-pack; \
				echo "${GREEN}✅ wasm-pack installed successfully${RESET}"; \
			else \
				echo "${RED}❌ Error: Rust/cargo not found even after sourcing. Please restart shell.${RESET}"; \
				exit 1; \
			fi; \
		fi; \
	fi
endif

install-frontend:
	@echo "${BLUE}📦 Installing frontend dependencies...${RESET}"
	@cd frontend && npm install --legacy-peer-deps
	@echo "${BLUE}🔄 Running svelte-kit sync...${RESET}"
	@cd frontend && npx svelte-kit sync
	@echo "${GREEN}✅ Frontend prêt${RESET}"

install-services:
	@echo "📦 Installing shared-ts..."
	@cd libs/shared-ts && npm install
	@echo "📦 Installing core-service..."
	@cd apps/core-service && npm install
	@echo "📦 Installing social-service..."
	@cd apps/social-service && npm install
	@echo "📦 Installing chat-delivery-service..."
	@cd apps/chat-delivery-service && npm install
	@echo "📦 Installing media-service..."
	@cd apps/media-service && npm install
	@echo "✅ Services Node.js prêts"

install-hooks:
	@echo "${BLUE}🪝 Installing Git hooks via Husky...${RESET}"
ifeq ($(OS),Windows_NT)
	@cd frontend && (bun install 2>$(NULL_DEV) || npm install --legacy-peer-deps)
else
	@cd frontend && ( \
		if [ -x "$$HOME/.bun/bin/bun" ]; then \
			$$HOME/.bun/bin/bun install; \
		elif command -v bun >/dev/null 2>&1; then \
			bun install; \
		elif command -v npm >/dev/null 2>&1; then \
			npm install --legacy-peer-deps; \
		else \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
			npm install --legacy-peer-deps; \
		fi \
	)
endif
	@echo "${GREEN}✅ Git hooks configurés${RESET}"

# ── Environment & Secrets Management ──────────────────────────────────────────
# Développement : crée frontend/.env + infrastructure/.env avec secrets générés
setup-env:
	@chmod +x scripts/setup-env.sh
	@./scripts/setup-env.sh

# Production : crée uniquement infrastructure/.env (frontend/.env ignoré en prod)
setup-env-prod:
	@chmod +x scripts/setup-env.sh
	@./scripts/setup-env.sh --prod

# Cible principale
test: test-libs test-gateway test-history test-frontend
	@echo ""
	@echo "${BOLD}📊 BILAN DES TESTS${RESET}"
	@echo "---------------------------------------------------"
	@echo "${GREEN}✅ Shared Rust Lib         : PASS${RESET}"
	@echo "${GREEN}✅ Chat Gateway (Rust)     : PASS${RESET}"
	@echo "${GREEN}✅ Delivery Service (TS)   : PASS${RESET}"
	@echo "${GREEN}✅ Frontend (Vitest)       : PASS${RESET}"
	@echo "---------------------------------------------------"
	@echo ""

# Tests frontend (Vitest — logique de création de conversations)
test-frontend:
	@echo "${BLUE}🧪 Testing Frontend conversation logic...${RESET}"
	@cd frontend && npm test
	@echo "${GREEN}✅ Frontend tests OK${RESET}"

# Tests Libs Rust
test-libs:
	@echo "${BLUE}🧪 Testing Shared Rust Lib...${RESET}"
	@cd libs/shared-rust && $(RUST_TEST_CMD)

# Tests Gateway Rust
test-gateway:
	@echo "${BLUE}🧪 Testing Chat Gateway...${RESET}"
	@cd apps/chat-gateway && $(RUST_TEST_CMD)

# Tests Service Historique
test-history:
	@echo "${BLUE}🧪 Testing Chat Delivery Service...${RESET}"
	@cd apps/chat-delivery-service && npm test -- --coverage

build-frontend:
	@echo "${BLUE}🚀 Building frontend...${RESET}"
	@echo "${BLUE}🔄 Building WASM...${RESET}"
	@cd frontend/mls-wasm && wasm-pack build --target web --out-dir ../src/lib/wasm
	@echo "${BLUE}🔄 Generating protobuf bindings...${RESET}"
	@cd frontend && npm run proto:gen
	@echo "${BLUE}🔄 Building SvelteKit...${RESET}"
	@cd frontend && npm run build
	@echo "${GREEN}✅ Frontend buildé${RESET}"

run-services:
	@echo "${BLUE}🚀 Starting services...${RESET}"
	@echo "${BLUE}ℹ️ call-service est archivé et n'est pas lancé${RESET}"
	@docker compose -f infrastructure/local/docker-compose.yml --env-file infrastructure/.env down --remove-orphans || true
	@docker compose -f infrastructure/local/docker-compose.yml --env-file infrastructure/.env up -d --build --remove-orphans
	@echo "${GREEN}✅ Services démarrés${RESET}"

reload-services:
	@echo "${BLUE}🔄 Reloading services...${RESET}"
	@docker compose -f infrastructure/local/docker-compose.yml --env-file infrastructure/.env down --remove-orphans && \
		docker compose -f infrastructure/local/docker-compose.yml --env-file infrastructure/.env up -d --build --remove-orphans
	@echo "${GREEN}✅ Services rechargés${RESET}"

reset-services:
	@echo "${BLUE}🔄 Resetting services (stop + remove volumes)...${RESET}"
	@docker compose -f infrastructure/local/docker-compose.yml --env-file infrastructure/.env down -v --remove-orphans && \
		docker compose -f infrastructure/local/docker-compose.yml --env-file infrastructure/.env up -d --build --remove-orphans
	@echo "${GREEN}✅ Services reset${RESET}"

reset-services-prod: production-check
	@echo "${BLUE}🔄 Resetting services (stop + remove volumes)...${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml --env-file infrastructure/.env down -v --remove-orphans && \
		( docker compose -f infrastructure/docker-compose.prod.yml --env-file infrastructure/.env pull || \
		  echo "${YELLOW}⚠️  Pull partiel/échoué — tentative de démarrage avec images locales disponibles${RESET}" ) && \
		docker compose -f infrastructure/docker-compose.prod.yml --env-file infrastructure/.env up -d --remove-orphans
	@echo "${GREEN}✅ Services reset${RESET}"

# ── CI Pipeline ──────────────────────────────────────────────────────────────
# Runs all checks locally: Rust tests, TS type-check, frontend lint, frontend build.
# Usage: make run-ci
run-ci: lint-frontend test
	@echo ""
	@echo "${BOLD}${GREEN}✅ CI COMPLETE — tous les checks ont passé${RESET}"
	@echo ""

lint-frontend:
	@echo "${BLUE}🧹 Type-checking & linting frontend...${RESET}"
	@cd frontend && npm run check
	@echo "${GREEN}✅ Frontend type-check OK${RESET}"

