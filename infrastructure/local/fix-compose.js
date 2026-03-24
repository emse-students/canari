
const fs = require("fs");
let yml = fs.readFileSync("docker-compose.yml", "utf-8");

yml = yml.replace(/  # ─────────────────────────────────────────────────────\s*  # Auth Service \(NestJS\) — New port 3012[\s\S]*?(?=volumes:)/, 
`  # ─────────────────────────────────────────────────────
  # Core Service (NestJS) — port 3012
  # Handles Auth, Users, Payment
  # ─────────────────────────────────────────────────────
  core-service:
    build:
      context: ../../
      dockerfile: infrastructure/local/Dockerfile.core-service
    ports:
      - "3012:3012"
    environment:
      PORT: "3012"
      JWT_SECRET: \${JWT_SECRET:-dev-jwt-secret-change-me}
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_USERNAME: admin
      DB_PASSWORD: password
      DB_DATABASE: auth_db
      STRIPE_SECRET_KEY: \${STRIPE_SECRET_KEY:-}
    depends_on:
      postgres:
        condition: service_started

  # ─────────────────────────────────────────────────────
  # Social Service (NestJS) — port 3014
  # Handles Channels, Posts, Forms
  # ─────────────────────────────────────────────────────
  social-service:
    build:
      context: ../../
      dockerfile: infrastructure/local/Dockerfile.social-service
    ports:
      - "3014:3014"
    environment:
      PORT: "3014"
      SOCIAL_MONGO_URI: mongodb://mongo:27017/social_db
      CHANNELS_ENCRYPTION_SECRET: \${CHANNELS_ENCRYPTION_SECRET:-dev-channel-secret-change-me}
      STRIPE_SECRET_KEY: \${STRIPE_SECRET_KEY:-}
      STRIPE_SUCCESS_URL: \${STRIPE_SUCCESS_URL:-http://localhost:5173/posts?registration=success}
      STRIPE_CANCEL_URL: \${STRIPE_CANCEL_URL:-http://localhost:5173/posts?registration=cancel}
      USER_SERVICE_URL: http://core-service:3012
      JWT_SECRET: \${JWT_SECRET:-change-me-in-production}
    depends_on:
      mongo:
        condition: service_started
      core-service:
        condition: service_started

`);
fs.writeFileSync("docker-compose.yml", yml);

