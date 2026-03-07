.PHONY: install install-frontend install-services test test-libs test-gateway test-history clean nginx-install nginx-uninstall nginx-https

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
install: install-frontend install-services

install-frontend:
	@echo "${BLUE}📦 Installing frontend dependencies...${RESET}"
	@cd frontend && npm install
	@echo "${BLUE}🔄 Running svelte-kit sync...${RESET}"
	@cd frontend && npx svelte-kit sync
	@echo "${GREEN}✅ Frontend prêt${RESET}"

install-services:
	@echo "${BLUE}📦 Installing shared-ts dependencies...${RESET}"
	@cd libs/shared-ts && npm install
	@echo "${BLUE}📦 Installing auth-service dependencies...${RESET}"
	@cd apps/auth-service && npm install
	@echo "${BLUE}📦 Installing user-service dependencies...${RESET}"
	@cd apps/user-service && npm install
	@echo "${BLUE}📦 Installing chat-delivery-service dependencies...${RESET}"
	@cd apps/chat-delivery-service && npm install
	@echo "${GREEN}✅ Services Node.js prêts${RESET}"

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
nginx-install:
	@echo "${BLUE}🔧 Deploying frontend build to $(WWW_DIR)...${RESET}"
	@sudo mkdir -p $(WWW_DIR)
	@sudo rsync -a --delete frontend/build/ $(WWW_DIR)/
	@sudo chown -R www-data:www-data $(WWW_DIR)
	@echo "${BLUE}🔧 Generating Nginx config for domain: ${BOLD}$(DOMAIN)${RESET}"
	@DOMAIN="$(DOMAIN)" \
	 GATEWAY_PORT="$(GATEWAY_PORT)" \
	 DELIVERY_PORT="$(DELIVERY_PORT)" \
	 FRONTEND_BUILD_PATH="$(WWW_DIR)" \
	 envsubst '$$DOMAIN $$GATEWAY_PORT $$DELIVERY_PORT $$FRONTEND_BUILD_PATH' \
	 < infrastructure/nginx/canari.conf.template \
	 > /tmp/$(NGINX_CONF_NAME).conf
	@sudo cp /tmp/$(NGINX_CONF_NAME).conf $(NGINX_SITES_AVAIL)/$(NGINX_CONF_NAME)
	@sudo ln -sf $(NGINX_SITES_AVAIL)/$(NGINX_CONF_NAME) $(NGINX_SITES_ENABLED)/$(NGINX_CONF_NAME)
	@sudo nginx -t && sudo systemctl reload nginx
	@echo "${GREEN}✅ Nginx configuré et rechargé pour $(DOMAIN)${RESET}"

nginx-uninstall:
	@sudo rm -f $(NGINX_SITES_ENABLED)/$(NGINX_CONF_NAME) $(NGINX_SITES_AVAIL)/$(NGINX_CONF_NAME)
	@sudo nginx -t && sudo systemctl reload nginx
	@echo "${GREEN}✅ Config Nginx supprimée${RESET}"

build-frontend:
	@echo "${BLUE}🚀 Building frontend...${RESET}"
	@cd frontend/mls-wasm && wasm-pack build --target web --out-dir ../src/lib/wasm
	@cd frontend && npm run build
	@echo "${GREEN}✅ Frontend buildé${RESET}"

run-services:
	@echo "${BLUE}🚀 Starting services...${RESET}"
	@docker compose -f infrastructure/local/docker-compose.yml up -d --build
	@echo "${GREEN}✅ Services démarrés${RESET}"

reload-services:
	@echo "${BLUE}🔄 Reloading services...${RESET}"
	@docker compose -f infrastructure/local/docker-compose.yml down -v && \
		docker compose -f infrastructure/local/docker-compose.yml up -d --build
	@echo "${GREEN}✅ Services rechargés${RESET}"