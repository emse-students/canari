#!/bin/bash

# ──────────────────────────────────────────────────────────────────────────────
# Canari Deployment Script
# Usage: ./deploy.sh [environment]
# Environments: local | production
# ──────────────────────────────────────────────────────────────────────────────

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

# Environment
ENV="${1:-local}"
COMPOSE_FILE=""

case "$ENV" in
  local)
    COMPOSE_FILE="infrastructure/local/docker-compose.yml"
    echo -e "${BLUE}📦 Deploying to LOCAL environment${RESET}"
    ;;
  production|prod)
    COMPOSE_FILE="infrastructure/docker-compose.prod.yml"
    echo -e "${BLUE}🚀 Deploying to PRODUCTION environment${RESET}"

    # Check if .env exists
    if [ ! -f "infrastructure/.env" ]; then
      echo -e "${YELLOW}⚠️  No .env file found. Creating from template...${RESET}"
      cp infrastructure/.env.example infrastructure/.env
      echo -e "${RED}❌ Please configure infrastructure/.env before deploying to production!${RESET}"
      exit 1
    fi

    # Load environment variables
    export $(cat infrastructure/.env | grep -v '^#' | xargs)
    ;;
  *)
    echo -e "${RED}❌ Unknown environment: $ENV${RESET}"
    echo "Usage: $0 [local|production]"
    exit 1
    ;;
esac

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}                 Canari Deployment Script                 ${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo ""

# Pre-deployment checks
echo -e "${BLUE}🔍 Running pre-deployment checks...${RESET}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed${RESET}"
    exit 1
fi

# Check Docker Compose
if ! docker compose version &> /dev/null; then
    echo -e "${RED}❌ Docker Compose is not installed${RESET}"
    exit 1
fi

echo -e "${GREEN}✅ Docker and Docker Compose are available${RESET}"

# Build or pull images
if [ "$ENV" = "local" ]; then
    echo ""
    echo -e "${BLUE}🏗️  Building Docker images...${RESET}"
    docker compose -f "$COMPOSE_FILE" build
else
    echo ""
    echo -e "${BLUE}📥 Pulling Docker images from registry...${RESET}"
    docker compose -f "$COMPOSE_FILE" pull
fi

# Stop existing containers
echo ""
echo -e "${BLUE}🛑 Stopping existing containers...${RESET}"
docker compose -f "$COMPOSE_FILE" down --remove-orphans

# Start services
echo ""
echo -e "${BLUE}🚀 Starting services...${RESET}"
docker compose -f "$COMPOSE_FILE" up -d

# Wait for health checks
echo ""
echo -e "${BLUE}⏳ Waiting for services to be healthy...${RESET}"
sleep 5

# Check service status
echo ""
echo -e "${BOLD}Service Status:${RESET}"
docker compose -f "$COMPOSE_FILE" ps

# Health checks
echo ""
echo -e "${BLUE}🔍 Running health checks...${RESET}"

HEALTHY=true

# Check Gateway
if curl -f http://localhost:3000/health &> /dev/null; then
    echo -e "${GREEN}✅ Chat Gateway is healthy${RESET}"
else
    echo -e "${RED}❌ Chat Gateway health check failed${RESET}"
    HEALTHY=false
fi

# Check Delivery Service
if curl -f http://localhost:3010/health &> /dev/null; then
    echo -e "${GREEN}✅ Chat Delivery Service is healthy${RESET}"
else
    echo -e "${RED}❌ Chat Delivery Service health check failed${RESET}"
    HEALTHY=false
fi

echo ""
if [ "$HEALTHY" = true ]; then
    echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}${GREEN}     ✅ Deployment completed successfully!                ${RESET}"
    echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════════${RESET}"
    echo ""
    echo -e "Access the application at:"
    if [ "$ENV" = "production" ]; then
        echo -e "  ${BLUE}https://${DOMAIN:-canari-emse.fr}${RESET}"
    else
        echo -e "  ${BLUE}http://localhost${RESET}"
    fi
    echo ""
    echo -e "View logs with:"
    echo -e "  ${YELLOW}docker compose -f $COMPOSE_FILE logs -f${RESET}"
    echo ""
else
    echo -e "${BOLD}${RED}═══════════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}${RED}     ⚠️  Deployment completed with errors                 ${RESET}"
    echo -e "${BOLD}${RED}═══════════════════════════════════════════════════════════${RESET}"
    echo ""
    echo -e "Check logs with:"
    echo -e "  ${YELLOW}docker compose -f $COMPOSE_FILE logs${RESET}"
    echo ""
    exit 1
fi
