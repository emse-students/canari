## P2 - the app is slow everywhere on a weak link (owner, 2026-11-10): five serial chains cut, the rest designed

The owner reopened the weak-network audit closed on 2026-10-14. Measured on dev at 500 ms RTT,
screen by screen ([weak-network-audit-2026-11-10](../frontend/weak-network-audit-2026-11-10.md)):
the stored screens paint in 0-1 round trips, the boot keeps the link busy for 15 serial levels
(~12 s), and a profile, an association page, Pour toi and bookings chain reads that need nothing
from each other.

**Built (one PR):** key-group and absent-conversation status reads asked together (N -> ceil(N/6)
round trips per connection), `avatar-presence` joins the request in flight, the dismissed list
beside the group list, a person's profile extras with the profile, and `push/register`, the
shut-phone reports and the `mls/*` reports off the rate-limit bucket the whole estate shared (the cold-start
`429`).

**Owed:**
- the same probe re-run on dev after the pre-release: the boot's level count (15 -> ~11 expected),
  a profile at 2 RTT, and no repeated `avatar-presence`;
- one production read of `[THROTTLE] REFUSED` on `registerPushToken` after
  the release, and the owner's next Android log free of the push `429`;
- the designed items, in the page's ranked order: C5 (one bulk read for the per-community key-group
  triplet), the encrypted thumbnail variant (WP-W7 of the first pass), C4 (the key-package path
  reads its device list once), C1-C3 (bookings, Pour toi, an association page - C1 and C2 in
  components other work was changing on 2026-11-10), the history restore stopping on the first
  transport failure mid-loop, `revoked-leaves` as a short server answer, C7-C8.
