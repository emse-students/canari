### Added - 1:1 audio calls on dev builds, peer to peer with Cloudflare TURN as the last resort

`call-service` relays the handshake of a two-person room and carries no media; production builds keep calls off, a call refuses rather than ever sending clear media, and a room is bound to its conversation and rings for the server's 60 s window ([calls](docs/wiki/frontend/modules/calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only)).
