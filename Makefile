.PHONY: test test-libs test-gateway test-history clean nginx-install nginx-uninstall

# ── Configuration déploiement Nginx ───────────────────────────────────────────
DOMAIN             ?= canari-emse.fr
GATEWAY_PORT       ?= 3000
DELIVERY_PORT      ?= 3001
FRONTEND_BUILD_PATH ?= $(shell pwd)/frontend/build
NGINX_CONF_NAME    ?= canari
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
	@echo "${BLUE}🔧 Generating Nginx config for domain: ${BOLD}$(DOMAIN)${RESET}"
	@DOMAIN="$(DOMAIN)" \
	 GATEWAY_PORT="$(GATEWAY_PORT)" \
	 DELIVERY_PORT="$(DELIVERY_PORT)" \
	 FRONTEND_BUILD_PATH="$(FRONTEND_BUILD_PATH)" \
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
