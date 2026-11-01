### Fixed - a chat reel cancelled offline no longer holds its upload session for a day

The release of a resumable upload session is now owed in durable state and retried at the next start or reconnect, and an account erasure ends the owner's open sessions on the server ([reels-in-chat](docs/wiki/frontend/modules/reels-in-chat.md#14-what-the-resumable-outbox-rc-5-built-and-what-it-owes-on-devices-2026-10-19)).
