## `LIVE_HOST_EGRESS_BPS` (90 Mb/s) rests on the workstation's path, not on the host: re-derive it and the 24-seat cap

target: 1.8.0

**Owner, 2026-11-19:** the app's own ceiling is **300 Mb/s** (half the ~600 measured from a near client),
set in the app, nothing on the host, nothing asked of the IT department; and the broadcaster moves from
`MediaRecorder` to **WebCodecs** (about 1 Mb/s at 720p instead of 2.6-3 on Android, so about 280 viewers
instead of about 100 at that ceiling), in `1.8.0` with the viewer cap ([decisions](owner-decisions-of-2026-11-19.md)).

`LIVE_HOST_EGRESS_BPS = 90_000_000` (`apps/social-service/src/lives/live.constants.ts`) and every
figure built on it - the 24-seat `LIVE_VIEWER_CAP`, arithmetic A and B1 of
[live-scaling](../frontend/modules/live-scaling.md#the-arithmetic), the cap row of
[lives](../services/lives.md), S2 of [live-production](../frontend/modules/live-production.md) -
come from the ~90-107 Mb/s plateau measured from ONE workstation on 2026-10-15. The owner-approved
measurement of 2026-11-17
([realtime-media-feasibility 4](../infrastructure/realtime-media-feasibility.md#4-network-capacity))
shows that plateau was the workstation's own path: a client close to the school's network reached
~600-660 Mb/s at 20 connections, and a distant client was bound by its own 85 Mb/s link.

**Owed:** the egress figure the cap may assume, from a measurement that separates the host from the
client's link (a near client gives the host's ceiling; the border path for far viewers is still
unmeasured past 85 Mb/s), the host's other tenants' share agreed with the school IT department (G14,
the shared link is not ours alone), then the constant, its comment, the cap and the three pages
above rewritten from it in one pull request. Planned with the
[viewer cap entry](live-viewer-cap-lifted-in-measured-steps.md), which it feeds.
