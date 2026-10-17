### Changed - the GIF search goes through Canari, never from the browser to KLIPY

The picker now asks chat-delivery's `GET /api/mls/gifs`, so KLIPY no longer receives a reader's query alongside their IP or a per-install id; the `klipy_cid` id is deleted at startup and the key left the bundles ([chat](docs/wiki/frontend/modules/chat.md#the-gif-search-goes-through-canari-2026-10-16)).
