const fs = require('fs');
const lines = fs.readFileSync('Makefile', 'utf-8').split('\n');
const start = lines.findIndex(l => l.startsWith('install-services:'));
const end = lines.findIndex((l, i) => i > start && l.includes('Services Node.js prêts'));
const before = lines.slice(0, start).join('\n');
const after = lines.slice(end + 1).join('\n');
const replace = `install-services:
\t@echo "$$\{BLUE}📦 Installing shared-ts...$$\{RESET}"
\t@cd libs/shared-ts && npm install
\t@echo "$$\{BLUE}📦 Installing auth-service...$$\{RESET}"
\t@cd apps/auth-service && npm install
\t@echo "$$\{BLUE}📦 Installing channel-service...$$\{RESET}"
\t@cd apps/channel-service && npm install
\t@echo "$$\{BLUE}📦 Installing chat-delivery-service...$$\{RESET}"
\t@cd apps/chat-delivery-service && npm install
\t@echo "$$\{BLUE}📦 Installing form-service...$$\{RESET}"
\t@cd apps/form-service && npm install
\t@echo "$$\{BLUE}📦 Installing media-service...$$\{RESET}"
\t@cd apps/media-service && npm install
\t@echo "$$\{BLUE}📦 Installing post-service...$$\{RESET}"
\t@cd apps/post-service && npm install
\t@echo "$$\{BLUE}📦 Installing user-service...$$\{RESET}"
\t@cd apps/user-service && npm install
\t@echo "$$\{GREEN}✅ Services Node.js prêts$$\{RESET}"`;
fs.writeFileSync('Makefile', before + '\n' + replace + '\n' + after);
