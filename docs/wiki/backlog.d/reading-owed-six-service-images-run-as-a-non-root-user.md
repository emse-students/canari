## Reading owed - six service images run as a non-root user

target: 1.7.0

**What is built:** six service images run as a non-root user (core, social, chat-delivery as `bun`; frontend-ssr as `node`; chat-gateway, call-service as `nobody`; batch 8, [cicd](../cicd.md#container-images-are-scanned-2026-10-23))

**The reading that closes it:** on dev after the next pre-release: each of the six containers up and healthy, no `EACCES` or `permission denied` in their logs; then one message, one media upload and one call on dev
