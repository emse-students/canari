## Reading owed - six service images run as a non-root user

target: 1.7.0

**What is built:** six service images run as a non-root user (core, social, chat-delivery as `bun`; frontend-ssr as `node`; chat-gateway, call-service as `nobody`; batch 8, [cicd](../cicd.md#container-images-are-scanned-2026-10-23))

**The reading that closes it:** on dev after the next pre-release: each of the six containers up and healthy, no `EACCES` or `permission denied` in their logs; then one message, one media upload and one call on dev

**Read 2026-11-14, read-only, both estates:** the six run as `bun` (core, social, chat-delivery),
`node` (frontend-ssr) and `nobody` (chat-gateway, call-service), all `healthy`; 0 `EACCES` and 0
`permission denied` in any Canari container log of either estate; production served 65 sends
(`201`) and a media upload (`201`) in the 12 hours of access log. **Left: one call**, on dev or
production - no `/api/call` connection was in either access log, so call-service's runtime under
`nobody` is not yet seen carrying a call.

**Again 2026-11-14, after the `1.6.12` deploy (read-only):** the production containers were
recreated at 09:11 UTC and are healthy; 0 `EACCES` and 0 `permission denied` since; still no call
in either estate's call-service or edge log, so the one call stays owed.
