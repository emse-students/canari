### Found - the origin's cache headers migrated intact, only the Cloudflare edge HIT layer is gone

Re-verified against the live host: `canari.emse.fr` serves the identical `Cache-Control` on
`/_app/immutable/*` and the shell that `canari-emse.fr` always has - nothing there was Cloudflare's
to begin with. What is genuinely gone is the shared edge cache itself, with no `cf-cache-status`
header at all on the new hostname; the nginx substitute for it was proposed and then refuted by
measurement
([backlog](docs/wiki/backlog.md#refuted---an-nginx-proxy_cache-substitute-for-the-lost-cloudflare-edge-cache-buys-3-ms-of-a-80-ms-path-measured-2026-09-25)).
