import re

with open("infrastructure/local/docker-compose.yml", "r", encoding="utf-8") as f:
    c = f.read()

c = re.sub(r'(\s+)build:\n\s+context: \.\./\.\.\n\s+dockerfile: .*\n', r'\n', c)

services = ['chat-gateway', 'call-service', 'chat-delivery-service', 'media-service', 'core-service', 'social-service']

for s in services:
    # Match EXACTLY ^  service_name:\n
    pattern = r'^  ' + s + r':\n'
    replacement = r'  ' + s + r':\n    image: ${REGISTRY:-ghcr.io}/${IMAGE_PREFIX:-emse-students/canari}/' + s + r':${TAG:-latest}\n    restart: always\n'
    c = re.sub(pattern, replacement, c, flags=re.MULTILINE)

fblock = """
  frontend:
    image: ${REGISTRY:-ghcr.io}/${IMAGE_PREFIX:-emse-students/canari}/frontend:${TAG:-latest}
    restart: always
    environment:
      NODE_ENV: production
      PORT: '3002'
      ORIGIN: ${ALLOW_ORIGIN:-https://canari-emse.fr}
      VITE_GATEWAY_URL: ${ALLOW_ORIGIN:-https://canari-emse.fr}
      VITE_DELIVERY_URL: ${ALLOW_ORIGIN:-https://canari-emse.fr}
    ports:
      - '3002:3002'

volumes:"""

# Only replace the top-level volumes:
c = re.sub(r'^volumes:', fblock, c, flags=re.MULTILINE)

with open("infrastructure/docker-compose.prod.yml", "w", encoding="utf-8") as f:
    f.write(c)

print("Done")
