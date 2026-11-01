### Fixed - an edge page no longer proves the server is reachable, and five writes no longer trust a portal's 200

A captive portal's `511`, the WAF's HTML `403` or an edge's 5xx page no longer clears the offline state, fires the reconnect or ends the reachability probe; the rename, group image, three notification-preference writes and `registerMember` read who answered before calling a 2xx done ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#22-only-our-apis-answer-proves-the-server-is-there-2026-11-01)).
