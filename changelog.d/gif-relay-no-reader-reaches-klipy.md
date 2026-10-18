### Changed - a GIF is loaded through Canari, never from KLIPY's CDN

A KLIPY GIF - in a chat, in the picker, in a comment - now goes through chat-delivery's GIF relay
(`/api/mls/gifs/media`: KLIPY's CDN only, 12 MiB, streamed, cached, throttled), so KLIPY no longer
sees a reader's address; a GIF from another host still loads directly, and a sent GIF keeps its
original URL for older clients
([chat](docs/wiki/frontend/modules/chat.md#the-gif-relay-no-readers-browser-asks-klipy-for-a-gif-2026-10-18)).
