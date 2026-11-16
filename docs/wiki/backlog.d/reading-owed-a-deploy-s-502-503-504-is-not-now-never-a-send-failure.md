## Reading owed - a deploy's `502`/`503`/`504` is "not now", never a send failure

target: 1.7.0

**What is built:** a deploy's `502`/`503`/`504` is "not now", never a send failure (R05, #3189, `v1.6.10`), and a route that stays dead fails a text with a retry after twelve ([chat](../frontend/modules/chat.md#a-deploys-not-now-is-not-a-send-failure-r05-2026-11-09), [offline-and-weak-network 17](../frontend/offline-and-weak-network.md#17-a-text-the-server-keeps-failing-becomes-failed-with-a-retry-user-2026-10-18))

**The reading that closes it:** a deploy drill on dev with the Mi 9T and the iPhone 12 sending DM and salon texts throughout: no "Echec", no "Non confirme", "En attente du serveur" while it lasts, each message ONCE on the peer; then the same across a production deploy

**Triage 2026-11-14 - left: a dev deploy drill with both phones sending, about 40 min** (a rolling restart of dev's gateway while the phones send DM and salon texts). "Then the same across a production deploy" is DELETED: a production deploy cannot be scheduled for a reading, and the dev drill exercises the same code and status codes.

**Web half, read 2026-11-16 on `1.7.0-alpha.2`** ([web rig](../device-verification.md#the-web-rig-readings-of-2026-11-16-on-170-alpha2)): NOT a deploy but a host restart (dev and production answered 502 for about two minutes from about 01:00 UTC, seen by `curl` on `/api/version`), taken by a 14-minute drill: a web seat sent a text to a group every 3 s (257 texts) while another web seat watched. Beta's bubbles read "En attente du serveur..." once, then "En attente..." for the outage's 40 sends, never "Echec" nor "Non confirme", then "Message envoye"; no send errored. **All 257 texts were on the watching seat exactly once, none missing, none doubled** (the script's own count read 60/197 because the list is windowed; a scroll-and-count over the whole list gave 257 unique). The phone half and a true deploy drill (`gh run list --workflow serve-dev.yml`) stay owed; this file stays.
