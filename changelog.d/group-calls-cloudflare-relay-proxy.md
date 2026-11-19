### Added - group calls can go through Cloudflare Realtime (server half, off in production)

`call_relay` gains `cloudflare`: chat-delivery proxies Cloudflare Realtime's sessions/tracks API behind the call gates, and a misconfigured relay refuses the call rather than falling back to the mesh ([calls](docs/wiki/frontend/modules/calls.md#the-cloudflare-relay-wp-gc3-server-half-2026-11-16)).
