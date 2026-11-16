## Reading owed - a deploy's `502`/`503`/`504` is "not now", never a send failure

target: 1.7.0

**What is built:** a deploy's `502`/`503`/`504` is "not now", never a send failure (R05, #3189, `v1.6.10`), and a route that stays dead fails a text with a retry after twelve ([chat](../frontend/modules/chat.md#a-deploys-not-now-is-not-a-send-failure-r05-2026-11-09), [offline-and-weak-network 17](../frontend/offline-and-weak-network.md#17-a-text-the-server-keeps-failing-becomes-failed-with-a-retry-user-2026-10-18))

**The reading that closes it:** a deploy drill on dev with the Mi 9T and the iPhone 12 sending DM and salon texts throughout: no "Echec", no "Non confirme", "En attente du serveur" while it lasts, each message ONCE on the peer; then the same across a production deploy

**Triage 2026-11-14 - left: a dev deploy drill with both phones sending, about 40 min** (a rolling restart of dev's gateway while the phones send DM and salon texts). "Then the same across a production deploy" is DELETED: a production deploy cannot be scheduled for a reading, and the dev drill exercises the same code and status codes.

**Mi 9T, 2026-11-16 (`1.7.0-alpha.2`, dev): PARTIAL** ([readings](../device-verification.md#the-mi-9t-readings-of-2026-11-16-the-owed-rows-170-alpha2)). `serve-dev.yml` is a `workflow_call` library, so `gh workflow run` cannot start it; the drill was a rolling restart of dev's chat-delivery and chat-gateway containers (4 s) and then a 38 s stop of chat-delivery, with the Mi sending 36 DM texts to a web seat throughout. All 36 arrived once on the peer, and no "Echec", "Non confirme" or "En attente du serveur" was on the Mi afterwards. **The edge logged no 502/503/504 in the windows**, so the status path itself was not shown, and the salon texts, the iPhone half and the production deploy were not taken. Left: a drill whose outage is proven to answer 502/503/504 (read the edge or the app's own log line), salon texts, the iPhone.

**iPhone 12, 2026-11-16 (`1.7.0-alpha.2`), DM half PARTIAL** ([readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-170-alpha2-the-all-entries-sitting)): dev's job re-run while the phone sent 34 DM texts - all sent, none flagged, each once on the peer, two gateway reconnects in 1 s; the edge answered 200 throughout, so no 502/503/504 was ever seen and the "not now" path was NOT exercised. **Left: a deploy that really drops the edge (or a fault injected on the route), the salon half, the Mi 9T.**
