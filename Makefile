.PHONY: test test-libs test-gateway test-history clean

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
	@echo "${BLUE}🧪 Testing Chat History Service...${RESET}"
	@cd apps/chat-history-service && npm test -- --coverage

build:
	@echo "${BLUE}🔨 Building all components...${RESET}"
	@cd libs/shared-rust && cargo build --release
	@cd apps/chat-gateway && cargo build --release
	@echo "${GREEN}✅ Build completed successfully!${RESET}"

build-frontend:
	@echo "\n${BLUE}🔨 Building frontend...${RESET}"
	@cd frontend/mls-core && cargo build --release
	@cd frontend/mls-wasm && wasm-pack build --release --target web --out-dir frontend/src/lib/wasm/
	@cd frontend && bun run build
	@echo "${GREEN}✅ Frontend build completed successfully!${RESET}"

run:
	@echo "\n${BLUE}🚀 Running all services...${RESET}"
	@cd apps/chat-gateway && cargo run &
	@cd apps/chat-history-service && npm start &
	@echo "${GREEN}✅ All services are running!${RESET}"

run-frontend:
	@echo "\n${BLUE}🚀 Running frontend...${RESET}"
	@cd frontend && bun run dev
	@echo "${GREEN}✅ Frontend is running!${RESET}"