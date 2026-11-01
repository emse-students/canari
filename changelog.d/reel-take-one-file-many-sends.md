### Added - a chat reel is one take for one or more conversations (RC-13, writer still off)

The outbox writes a take and its sends in one transaction, uploads the file once (or adopts the CanaReels upload under a chat hold), and keeps the take only while a send names it; the daily budget's 429 now fails a take's sends for good, and no late write can bring back a withdrawn outbox row ([reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md#17-what-the-multi-target-outbox-rc-13-built-2026-11-01)).
