### Found - the Cloudflare-to-host-nginx audit found `canari.emse.fr` couldn't carry a WebSocket

Re-checked every deliberate Cloudflare zone setting against the live host: TLS floor holds, the
`www.` question is moot (no such DNS record), CSP and CSRF were never Cloudflare's job.
`canari.conf` never forwarded `Upgrade`/`Connection`, unlike its `canari-prod`/`canari-dev`
siblings, so `/api/ws` got a bare nginx 400 instead of reaching the app - the fix is a live host
config edit, owed to the user separately. A second real gap, NOT yet closed: no rate limiting
exists on the shared host at all, tracked as its own item
([backlog](docs/wiki/backlog.md#p2---no-rate-limiting-exists-on-the-authentication-or-upload-paths-on-the-shared-host-on-any-vhost-found-2026-09-25)).
Full audit: [estate-migration](docs/wiki/infrastructure/estate-migration.md#what-the-edge-did-that-the-origin-must-now-do).
