### Changed - a DM or group file shows its bubble at the tap and is queued like a text

The pre-send wait for the inbound queue and the membership check (18 s on a stalled link, nothing
on screen) is gone: the placeholder and its outbox entry are written together at the tap, and the
outbox's own gates hold, retire or send it ([chat](docs/wiki/frontend/modules/chat.md#a-file-is-queued-at-the-tap-like-a-text-2026-11-01)).
