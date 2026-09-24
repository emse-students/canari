### Found - the origin's cache headers migrated intact, only the Cloudflare edge HIT layer is gone

Re-verified against the live host: `canari.emse.fr` serves the identical `Cache-Control` on
`/_app/immutable/*` and the shell that `canari-emse.fr` always has - nothing there was Cloudflare's
to begin with. What is genuinely gone is the shared edge cache itself, with no `cf-cache-status`
header at all on the new hostname. An nginx `proxy_cache` substitute is proposed, not built
([backlog](docs/wiki/backlog.md#p3---an-nginx-proxy_cache-substitute-for-the-lost-cloudflare-edge-hit-layer-is-undesigned-found-2026-09-25)).
