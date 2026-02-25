.PHONY: test test-libs test-gateway test-history clean

# Couleurs et Styles
GREEN  := $(shell tput -Txterm setaf 2)
RED    := $(shell tput -Txterm setaf 1)
BLUE   := $(shell tput -Txterm setaf 4)
BOLD   := $(shell tput -Txterm bold)
RESET  := $(shell tput -Txterm sgr0)

# Cible principale
test: test-libs test-gateway test-history
	@echo ""
	@echo "${BOLD}📊 BILAN DES TESTS${RESET}"
	@echo "---------------------------------------------------"
	@echo "${GREEN}✅ Shared Rust Lib      : PASS${RESET}"
	@echo "${GREEN}✅ Chat Gateway (Rust)  : PASS${RESET}"
	@echo "${GREEN}✅ History Service (TS) : PASS${RESET}"
	@echo "---------------------------------------------------"
	@if [ -d "apps/chat-history-service/coverage" ]; then \
		echo "${BLUE}ℹ️  Coverage disponible pour History Service: apps/chat-history-service/coverage/lcov-report/index.html${RESET}"; \
	fi
	@echo ""

# Tests Libs Rust (avec détection de tarpaulin pour le coverage)
test-libs:
	@echo "\n${BLUE}🧪 Testing Shared Rust Lib...${RESET}"
	@cd libs/shared-rust && if command -v cargo-tarpaulin >/dev/null; then \
		echo "   (Coverage enabled via cargo-tarpaulin)"; \
		cargo tarpaulin --out Xml --output-dir coverage; \
	else \
		cargo test; \
	fi

# Tests Gateway Rust (avec détection de tarpaulin pour le coverage) 
test-gateway:
	@echo "\n${BLUE}🧪 Testing Chat Gateway...${RESET}"
	@cd apps/chat-gateway && if command -v cargo-tarpaulin >/dev/null; then \
		echo "   (Coverage enabled via cargo-tarpaulin)"; \
		cargo tarpaulin --out Xml --output-dir coverage; \
	else \
		cargo test; \
	fi

# Tests Service Historique (avec Coverage Jest)
test-history:
	@echo "\n${BLUE}🧪 Testing Chat History Service...${RESET}"
	@cd apps/chat-history-service && npm test -- --coverage
