## P3 - A share already drained into the picker does not survive a kill (Mi 9T, 2026-10-28)

Accepted as designed (2026-10-28): [sharing](../frontend/sharing.md) promises a waiting share survives
a kill only while the page has not taken it. Read on 1.5.1: a text share left open in "Envoyer
a..." (`pending_share.json drained`), the app force-stopped and relaunched - nothing offered again.
