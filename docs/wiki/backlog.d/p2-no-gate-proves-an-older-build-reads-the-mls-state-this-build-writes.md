## P2 - no gate proves that an older build reads, and writes back, the MLS state this build writes

target: 1.7.1

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

Found by the review of #2515 (2026-11-15). The state gained `app_ledgers` (KILL-2), carried by
`#[serde(default)]` and dropped by an older build on its next write. The backward half is gated:
`frontend/mls-core/tests/cross_version_state.rs` opens a state that v0.14.14 froze. The forward half
is not: `.github/scripts/mls-forward-compat.sh` builds the old tag and exercises FRAMES only (Welcome,
then application frames both ways), never a state blob. "An older build ignores the unknown field"
is today a reading of serde's default, not a measured fact - and a rollback or a mixed-version fleet
is exactly when it is relied on.

**The gate owed.** A STATE leg in `mls-forward-compat.sh` and the `frontend/mls-cross-version`
driver:

1. today's code builds a state holding a group AND `app_ledgers` (a seen ledger, `send-persisted`,
   `ledger-format`), and saves it;
2. the old tag's binary loads that state, decrypts a frame in the group, and saves it back;
3. today's code loads the result and asserts what the old write did: the group and its ratchet are
   intact, `app_ledgers` is EMPTY (dropped, not corrupted), and the app's handling of that case
   holds - the migration sees no `ledger-format` and re-stages, and nothing is over- or
   under-counted beyond the documented over-burn
   ([mls-desync-prevention](../protocols/mls-desync-prevention.md#the-ledgers-that-describe-the-state-travel-inside-it-kill-2-2026-10-26)).

A failure names its leg (old load, old save, new reload), as the frame legs already do. The same leg
then covers every later `#[serde(default)]` field of `PersistedState` (`member_sightings`,
`graine_runs`, `admission`), which today ride on the same unmeasured assumption.
