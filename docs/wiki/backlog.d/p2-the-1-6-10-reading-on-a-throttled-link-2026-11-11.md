## P2 - the 1.6.10 reading on a throttled link (2026-11-11): four findings, three fixed, one for the media PR; the Mi 9T re-reading is owed

**The reading.** Production `1.6.10` on an Android phone through a throttling CONNECT proxy: +800 ms RTT,
250 kbps down, 100 kbps up, WebView HTTP only (the native WebSocket path bypassed the proxy and stayed
fast). Read-only navigation. Principle held: discreet and informative, never verbose or useless.

1. **False "Hors connexion"** (twice, answers still arriving). Cause: `connectivity.svelte.ts`
   `trackRequest().failed()` counted every `RequestDeadlineError` (20 s read deadline) as a stall and two
   in a row as unreachable, with no regard for answers arriving meanwhile. Fixed: a deadline that
   expired after another answer arrived is slow, not a stall. The banner also shifted the page ~126 px;
   the banner is deleted, the connection is a ring (no layout space).
2. **The ring** was an amber rounded square. Owner decision: keep it, make it a true circle, make it THE
   indicator (green connected, amber slow, grey offline/reconnecting) on both headers, replace the
   banner and the desktop "connecte" pill. `ConnectionAnnouncer` keeps the screen-reader sentences.
3. **"Utilisateur inconnu" on 1:1 rows for 12 s+.** Cause: names lived in a per-launch Map filled only by
   a profile fetch; the list and the conversation header share the same resolver, so the header was
   fast only once its fetch had landed. Fixed: a per-account name directory, sealed in the account's encrypted database (the feed pages' store) and read first.
4. **Video first frame lost across tab switches** (~40 s, black again after a tab round trip): belongs to
   the media poster and preload work of #3337; not duplicated here.

**Owed.** A re-reading on the Mi 9T under the same proxy after a pre-release: no grey ring while answers
arrive, rows named on the first frame of a cold start, the ring a circle in light and dark on both
headers, the live region announcing offline and back. Also owed: the first frame before the device key is in hand (a cold start with a PIN to type) shows initials, then the names once unlocked. Mechanism:
[offline-and-weak-network](../frontend/offline-and-weak-network.md#the-connection-ring-owner-2026-11-11).
