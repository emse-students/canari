## Decided by the user on 2026-10-18 - every design question answered

target: 1.8.0

**Re-read 2026-11-11.** Rows elsewhere in this file point here. What shipped was removed: WP-DEL-LOCAL
(#2023), the presence audience half (#2031), WP-SMOKE-LOGIN (#2020, #2073), WP-HOLD-NOTHING (#2027),
WP-REELS-MENU (#2021), WP-PUSH-I18N (#2037) and WP-MENTION-NAME (#2047). Their readings are rows of
[the readings owed](../plan.md#readings-owed). WP-NICK-COMMUNITY-RULES shipped with
the nicknames (#3177: "Defini par", a nickname kept when its setter leaves). Five have their own
entries, which carry their state:
- WP-PRESENCE's push half: [the presence poll](p3-the-phone-polls-presence-every-ten-seconds-over-a-live-websocket-2026-09-02.md);
- WP-CHECKPOINT-SKIP: [open-questions](../open-questions.md#decided-2026-11-07-lead-owners-delegation-build-with-k100-behind-checkpoint_skip_mode-off-flip-after-the-dev-readings-below);
- WP-RESTORE-1: [its design](../account-restore.md); the entry is closed (owner, 2026-11-14);
- WP-MIGALLERY-OFFSITE: [the offsite](p2-migallery-s-only-offsite-still-lands-on-the-old-canari-vm.md);
- WP-SECOND-CAMPAIGN-VENUE: [the second campaign](a-second-campaign-for-everything-that-is-not-chat-asked-2026-08-16.md).

Still open here:
- **WP-COORG-ACCEPT-NOTICE (S-M, server + native tables, no MLS): notify the organiser when a
  co-organisation is accepted on a PENDING event.** An acceptance on a VALIDATED event already
  notifies (`event_pending_coorganiser`, WP-Q2 #2973, `announceEventReopened`); on a pending one,
  `CoorganisationService.apply` still announces nothing. The client floor it waited for (#1911) is
  below every estate's `minClientVersion`.
- **WP-TEST-TOOLING-REFORM (L, harness, no native): the whole test tooling is reformed NOW** (user:
  "on est a un nombre de test aberrant"). Done: the inventory (#2129), the ten byte-identical spec
  copies deleted ([test-suite-reform 7.2](../test-suite-reform.md#72-the-declared-copies-deleted-2026-10-21)),
  the frontend desk items ([7.3](../test-suite-reform.md#73-the-frontend-desk-items-2026-10-21)).
  **Left**: WP-T7, the rig change, one campaign session with its re-runs.

Decided, no work: a device revoked while offline keeps its sealed residue until a login on it (no
unauthenticated revocation route, no local expiry); the stale "added a member" bubbles from before
#1870 are left alone; iOS keeps its native stacking of post reactions under `post_reaction_<postId>`.
