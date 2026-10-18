# The runtime the NestJS services run on, at the version their Dockerfiles pin.
FROM oven/bun:1.4.3-alpine
ARG VERSION
ENV VERSION=${VERSION}
COPY api.mjs /app/api.mjs
CMD ["bun", "/app/api.mjs"]
