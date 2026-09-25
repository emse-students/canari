### Fixed - the legacy origin was answering 502 and the edge cache hid it

`canari-emse.fr` returned `502` at its own origin while browsers kept getting a normal page from
Cloudflare's cache; `dev.canari-emse.fr`, with no warm cache, was visibly broken. SvelteKit's
~7.5 KB `Link: rel=modulepreload` header overflowed nginx's default 4 KB `proxy_buffer_size` on the
four vhosts written before that lesson (`canari-prod`, `canari-dev` and both relays). Buffers raised
on both hosts; both origins now answer `200`
([estate-migration](docs/wiki/infrastructure/estate-migration.md#the-legacy-hostname-was-answering-502-at-the-origin-and-the-edge-cache-hid-it-2026-09-25)).
