### Fixed - `canari.emse.fr` can carry a WebSocket now

`sites-available/canari.conf` on the shared host never forwarded `Upgrade`/`Connection`, unlike its
`canari-prod`/`canari-dev` siblings, so real-time chat, presence and calling were silently
unreachable on the now-primary hostname. Added the same two `proxy_set_header` lines the working
vhosts already carry and reloaded nginx; a WS handshake now reaches the app and gets `401`
(unauthenticated, the correct answer) instead of a bare `400`
([estate-migration](docs/wiki/infrastructure/estate-migration.md#what-the-edge-did-that-the-origin-must-now-do)).
