## Reading owed - a deploy's `502`/`503`/`504` is "not now", never a send failure

target: 1.7.0

**What is built:** a deploy's `502`/`503`/`504` is "not now", never a send failure (R05, #3189, `v1.6.10`), and a route that stays dead fails a text with a retry after twelve ([chat](../frontend/modules/chat.md#a-deploys-not-now-is-not-a-send-failure-r05-2026-11-09), [offline-and-weak-network 17](../frontend/offline-and-weak-network.md#17-a-text-the-server-keeps-failing-becomes-failed-with-a-retry-user-2026-10-18))

**The reading that closes it:** a deploy drill on dev with the Mi 9T and the iPhone 12 sending DM and salon texts throughout: no "Echec", no "Non confirme", "En attente du serveur" while it lasts, each message ONCE on the peer; then the same across a production deploy
