.PHONY: all install install-node install-bun install-rust install-wasm-pack install-frontend install-services install-hooks setup-env setup-env-prod production production-check build-frontend nginx-install reload-services test test-libs test-gateway test-history clean nginx-uninstall nginx-https

# Cible par défaut : installation complète et déploiement LOCAL
.DEFAULT_GOAL := all

all: install install-hooks build-frontend nginx-install reload-services
	@echo ""
	@echo "${BOLD}${GREEN}🎉 INSTALLATION COMPLÈTE TERMINÉE (DEV LOCAL)${RESET}"
	@echo "---------------------------------------------------"
	@echo "${GREEN}✅ Dépendances installées${RESET}"
	@echo "${GREEN}✅ Git hooks configurés${RESET}"
	@echo "${GREEN}✅ Frontend buildé${RESET}"
	@echo "${GREEN}✅ Nginx configuré${RESET}"
	@echo "${GREEN}✅ Services Docker rechargés${RESET}"
	@echo "---------------------------------------------------"
	@echo ""

# ── Déploiement Production ────────────────────────────────────────────────────
production: production-check
	@echo ""
	@echo "${BOLD}${BLUE}🚀 DÉPLOIEMENT PRODUCTION${RESET}"
	@echo "---------------------------------------------------"
	@echo "${BLUE}📥 Pulling Docker images from GHCR...${RESET}"
	@docker compose -f infrastructure/docker-compose.prod.yml pull
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
	@if [ ! -f infrastructure/.env ]; then \
		echo "${YELLOW}⚠️  Fichier infrastructure/.env manquant${RESET}"; \
		echo "${BLUE}📝 Création depuis .env.example...${RESET}"; \
		cp infrastructure/.env.example infrastructure/.env; \
		echo ""; \
		echo "${RED}╔═══════════════════════════════════════════════════════════╗${RESET}"; \
		echo "${RED}║  ⚠️  CONFIGURATION REQUISE                                ║${RESET}"; \
		echo "${RED}╚═══════════════════════════════════════════════════════════╝${RESET}"; \
		echo ""; \
		echo "${YELLOW}Avant de continuer, éditez infrastructure/.env :${RESET}"; \
		echo ""; \
		echo "  ${BLUE}1. Générer un secret JWT :${RESET}"; \
		echo "     openssl rand -hex 32"; \
		echo ""; \
		echo "  ${BLUE}2. Éditer le fichier :${RESET}"; \
		echo "     nano infrastructure/.env"; \
		echo ""; \
		echo "  ${BLUE}3. Configurer ces variables :${RESET}"; \
		echo "     - JWT_SECRET=<résultat de openssl rand -hex 32>"; \
		echo "     - POSTGRES_PASSWORD=<mot de passe sécurisé>"; \
		echo "     - DOMAIN=canari-emse.fr"; \
		echo ""; \
		echo "  ${BLUE}4. Relancer :${RESET}"; \
		echo "     make production"; \
		echo ""; \
		exit 1; \
	fi
	@if [ ! -f frontend/.env ]; then \
		echo "${YELLOW}⚠️  Fichier frontend/.env manquant${RESET}"; \
		echo "${BLUE}📝 Création depuis .env.example...${RESET}"; \
		cp frontend/.env.example frontend/.env; \
	fi
	@echo "${BLUE}🔐 Synchronisation des secrets JWT...${RESET}"
	@chmod +x scripts/setup-env.sh
	@./scripts/setup-env.sh --prod --sync-only || { \
		echo ""; \
		echo "${RED}╔═══════════════════════════════════════════════════════════╗${RESET}"; \
		echo "${RED}║  ❌ ERREUR DE CONFIGURATION                               ║${RESET}"; \
		echo "${RED}╚═══════════════════════════════════════════════════════════╝${RESET}"; \
		echo ""; \
		echo "${YELLOW}Vérifiez que :${RESET}"; \
		echo "  1. infrastructure/.env contient un JWT_SECRET valide (64 char hex)"; \
		echo "  2. frontend/.env contient le même secret dans VITE_JWT_SECRET"; \
		echo ""; \
		echo "${BLUE}Pour générer un secret valide :${RESET}"; \
		echo "  openssl rand -hex 32"; \
		echo ""; \
		exit 1; \
	}
	@echo "${GREEN}✅ Configuration validée${RESET}"

# ── Configuration déploiement Nginx ───────────────────────────────────────────
DOMAIN             ?= canari-emse.fr
GATEWAY_PORT       ?= 3000
DELIVERY_PORT      ?= 3001
NGINX_CONF_NAME    ?= canari
WWW_DIR            := /var/www/$(NGINX_CONF_NAME)
FRONTEND_BUILD_PATH := $(WWW_DIR)
NGINX_SITES_AVAIL  := /etc/nginx/sites-available
NGINX_SITES_ENABLED:= /etc/nginx/sites-enabled

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
ifeq ($(OS),Windows_NT)
	@cd frontend && ($(CHECK_CMD) bun >$(NULL_DEV) 2>&1 && bun install || npm install --legacy-peer-deps)
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
	@echo "${BLUE}🔄 Running svelte-kit sync...${RESET}"
ifeq ($(OS),Windows_NT)
	@cd frontend && ($(CHECK_CMD) bunx >$(NULL_DEV) 2>&1 && bunx svelte-kit sync || npx svelte-kit sync)
else
	@cd frontend && ( \
		if [ -x "$$HOME/.bun/bin/bun" ]; then \
			$$HOME/.bun/bin/bunx svelte-kit sync; \
		elif command -v bunx >/dev/null 2>&1; then \
			bunx svelte-kit sync; \
		elif command -v npx >/dev/null 2>&1; then \
			npx svelte-kit sync; \
		else \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
			npx svelte-kit sync; \
		fi \
	)
endif
	@echo "${GREEN}✅ Frontend prêt${RESET}"

install-services:
	@echo "${BLUE}📦 Installing shared-ts dependencies...${RESET}"
ifeq ($(OS),Windows_NT)
	@cd libs/shared-ts && npm install
else
	@cd libs/shared-ts && ( \
		if [ -x "$$HOME/.bun/bin/bun" ]; then \
			$$HOME/.bun/bin/bun install; \
		elif command -v bun >/dev/null 2>&1; then \
			bun install; \
		elif command -v npm >/dev/null 2>&1; then \
			npm install; \
		else \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
			npm install; \
		fi \
	)
endif
	@echo "${BLUE}📦 Installing auth-service dependencies...${RESET}"
ifeq ($(OS),Windows_NT)
	@cd apps/auth-service && npm install
else
	@cd apps/auth-service && ( \
		if [ -x "$$HOME/.bun/bin/bun" ]; then \
			$$HOME/.bun/bin/bun install; \
		elif command -v bun >/dev/null 2>&1; then \
			bun install; \
		elif command -v npm >/dev/null 2>&1; then \
			npm install; \
		else \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
			npm install; \
		fi \
	)
endif
	@echo "${BLUE}📦 Installing user-service dependencies...${RESET}"
ifeq ($(OS),Windows_NT)
	@cd apps/user-service && npm install
else
	@cd apps/user-service && ( \
		if [ -x "$$HOME/.bun/bin/bun" ]; then \
			$$HOME/.bun/bin/bun install; \
		elif command -v bun >/dev/null 2>&1; then \
			bun install; \
		elif command -v npm >/dev/null 2>&1; then \
			npm install; \
		else \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
			npm install; \
		fi \
	)
endif
	@echo "${BLUE}📦 Installing chat-delivery-service dependencies...${RESET}"
ifeq ($(OS),Windows_NT)
	@cd apps/chat-delivery-service && npm install
else
	@cd apps/chat-delivery-service && ( \
		if [ -x "$$HOME/.bun/bin/bun" ]; then \
			$$HOME/.bun/bin/bun install; \
		elif command -v bun >/dev/null 2>&1; then \
			bun install; \
		elif command -v npm >/dev/null 2>&1; then \
			npm install; \
		else \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
			npm install; \
		fi \
	)
endif
	@echo "${GREEN}✅ Services Node.js prêts${RESET}"

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
setup-env:
	@echo "${BLUE}🔐 Setting up environment files and generating secrets...${RESET}"
	@chmod +x scripts/setup-env.sh
	@./scripts/setup-env.sh
	@echo "${GREEN}✅ Environment setup complete${RESET}"

setup-env-prod:
	@echo "${BLUE}🔐 Syncing secrets in production mode...${RESET}"
	@chmod +x scripts/setup-env.sh
	@./scripts/setup-env.sh --prod --sync-only
	@echo "${GREEN}✅ Production secrets synchronized${RESET}"

# Cible principale
test: test-libs test-gateway test-history
	@echo ""
	@echo "${BOLD}📊 BILAN DES TESTS${RESET}"
	@echo "---------------------------------------------------"
	@echo "${GREEN}✅ Shared Rust Lib      : PASS${RESET}"
	@echo "${GREEN}✅ Chat Gateway (Rust)  : PASS${RESET}"
	@echo "${GREEN}✅ History Service (TS) : PASS${RESET}"
	@echo "---------------------------------------------------"
	@echo ""

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

# ── Nginx ─────────────────────────────────────────────────────────────────────
ifeq ($(OS),Windows_NT)
nginx-install:
	@echo "${BLUE}ℹ️ Skipping Nginx install on Windows (sudo/nginx not available)${RESET}"
	@echo "${BLUE}ℹ️ Use local Docker services instead: make run-services${RESET}"

nginx-uninstall:
	@echo "${BLUE}ℹ️ Skipping Nginx uninstall on Windows${RESET}"
else
nginx-install:
	@echo "${BLUE}🔧 Deploying frontend build to $(WWW_DIR)...${RESET}"
	@sudo mkdir -p $(WWW_DIR)
	@sudo rsync -a --delete frontend/build/ $(WWW_DIR)/
	@sudo chown -R www-data:www-data $(WWW_DIR)
	@echo "${BLUE}🔧 Generating Nginx config for domain: ${BOLD}$(DOMAIN)${RESET}"
	@TMPFILE=$$(mktemp) && \
	 DOMAIN="$(DOMAIN)" \
	 GATEWAY_PORT="$(GATEWAY_PORT)" \
	 DELIVERY_PORT="$(DELIVERY_PORT)" \
	 FRONTEND_BUILD_PATH="$(WWW_DIR)" \
	 envsubst '$$DOMAIN $$GATEWAY_PORT $$DELIVERY_PORT $$FRONTEND_BUILD_PATH' \
	 < infrastructure/nginx/canari.conf.template \
	 > "$$TMPFILE" && \
	 sudo cp "$$TMPFILE" $(NGINX_SITES_AVAIL)/$(NGINX_CONF_NAME) && \
	 rm -f "$$TMPFILE"
	@sudo ln -sf $(NGINX_SITES_AVAIL)/$(NGINX_CONF_NAME) $(NGINX_SITES_ENABLED)/$(NGINX_CONF_NAME)
	@sudo nginx -t && sudo systemctl reload nginx
	@echo "${GREEN}✅ Nginx configuré et rechargé pour $(DOMAIN)${RESET}"

nginx-uninstall:
	@sudo rm -f $(NGINX_SITES_ENABLED)/$(NGINX_CONF_NAME) $(NGINX_SITES_AVAIL)/$(NGINX_CONF_NAME)
	@sudo nginx -t && sudo systemctl reload nginx
	@echo "${GREEN}✅ Config Nginx supprimée${RESET}"
endif

build-frontend:
	@echo "${BLUE}🚀 Building frontend...${RESET}"
ifeq ($(OS),Windows_NT)
	@cd frontend/mls-wasm && wasm-pack build --target web --out-dir ../src/lib/wasm
	@cd frontend && ($(CHECK_CMD) bun >$(NULL_DEV) 2>&1 && bun run build || npm run build)
else
	@cd frontend/mls-wasm && ( \
		if command -v wasm-pack >/dev/null 2>&1; then \
			wasm-pack build --target web --out-dir ../src/lib/wasm; \
		else \
			. "$$HOME/.cargo/env" 2>/dev/null || true; \
			wasm-pack build --target web --out-dir ../src/lib/wasm; \
		fi \
	)
	@cd frontend && ( \
		if [ -x "$$HOME/.bun/bin/bun" ]; then \
			$$HOME/.bun/bin/bun run build; \
		elif command -v bun >/dev/null 2>&1; then \
			bun run build; \
		elif command -v npm >/dev/null 2>&1; then \
			npm run build; \
		else \
			export NVM_DIR="$$HOME/.nvm"; \
			[ -s "$$NVM_DIR/nvm.sh" ] && \. "$$NVM_DIR/nvm.sh"; \
			npm run build; \
		fi \
	)
endif
	@echo "${GREEN}✅ Frontend buildé${RESET}"

run-services:
	@echo "${BLUE}🚀 Starting services...${RESET}"
	@docker compose -f infrastructure/local/docker-compose.yml down --remove-orphans || true
	@docker compose -f infrastructure/local/docker-compose.yml up -d --build --remove-orphans
	@echo "${GREEN}✅ Services démarrés${RESET}"

reload-services:
	@echo "${BLUE}🔄 Reloading services...${RESET}"
	@docker compose -f infrastructure/local/docker-compose.yml down --remove-orphans && \
		docker compose -f infrastructure/local/docker-compose.yml up -d --build --remove-orphans
	@echo "${GREEN}✅ Services rechargés${RESET}"
