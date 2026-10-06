### The nginx access log no longer records the WebSocket token

`?token=` values are redacted in the container's access log, auth unchanged; see [nginx](../docs/wiki/infrastructure/nginx.md#the-access-log-never-records-a-token-2026-10-06). Gate: `access-log-redaction.test.mjs`.
