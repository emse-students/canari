### Changed - a GIF is loaded through Canari, never from KLIPY's CDN

Every recipient of a GIF, the picker's thumbnails and a comment's GIF now go through chat-delivery's
GIF relay (`/api/mls/gifs/media`: KLIPY's CDN only, 12 MiB, streamed, cached), so KLIPY no longer
sees a reader's address; a sent GIF keeps its original URL for older clients
([chat](docs/wiki/frontend/modules/chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18)).
