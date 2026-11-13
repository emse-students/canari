## P2 - the app is slow everywhere on a weak link (owner, 2026-11-10): five serial chains cut, the rest designed

target: 1.7.0

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

**Built (second PR, 2026-11-11):** C1, C2 (the blocks with the feed) and C3 (the bell with the
sub-reads), one round trip each; the boot restore stopping at the conversation that finds the link
known down; the request gate checked (API reads never queue behind media, no lane needed) -
[audit 3.8-3.9](../frontend/weak-network-audit-2026-11-10.md).

**Owed:**
- the same probe re-run on dev after the pre-release: the boot's level count (15 -> ~11 expected),
  a profile at 2 RTT, and no repeated `avatar-presence`;
- one production read of `[THROTTLE] REFUSED` on `registerPushToken` after
  the release, and the owner's next Android log free of the push `429`;
- the designed items, in the page's ranked order: C5 (one bulk read for the per-community key-group
  triplet), the encrypted thumbnail variant (WP-W7 of the first pass), C4 (the key-package path
  reads its device list once), the server halves: C2's follow statuses in the feed row, C3's slug-keyed sub-reads, C4
  (`register-device` answering the published count), `revoked-leaves` as a `GET`, C7-C8; and one
  phone reading of the bandwidth share between media and API reads.
