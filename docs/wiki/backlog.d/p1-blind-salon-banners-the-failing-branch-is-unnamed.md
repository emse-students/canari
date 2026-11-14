## Reading owed - the `[PUSH_BLIND] refused=` reasons on production and on a real-size key group

target: 1.7.0

Production, one day of chat-delivery logs (2026-11-04): 16 `[PUSH_BLIND]` lines from 3 accounts,
all `missing=seed`, Android `held=true`, iOS `held=false`.

**What is known.**

- **iOS `held=false` says nothing about the push.** The NSE never reports `held=true`: nothing
  redraws its banner once `finish()` runs (`NotificationService.swift`, `reportBlindBanner`;
  [channel-encryption](../protocols/channel-encryption.md)). So the iOS lines do not show that the
  push carried no frame; they have the same unknown cause as the Android ones.
- **The primary path works on the bench** (Mi 9T, `1.6.4-alpha.2`, dev, app killed with
  `am kill` and its `mls.bin` at key-group epoch 6). Run 1: one key-group commit (a new web device),
  then a salon message from another account at epoch 7. Run 2: two more commits (two new devices of
  a member already present), then a message at epoch 9. Both times `tryDecrypt` returned
  `mls-refused`, `groupLocality` returned `LOCAL`, `fetchCommitsFromBackend` returned 1 and then 3
  commits, the in-memory catch-up yielded the seed (`absorbGraineSeeds: stored 1`), and the banner
  showed the text (`showsMessage=true`). The whole run took about 0.7 s. Run 2 also confirms the D5
  rule ([graine-removal-tracker](../protocols/graine-removal-tracker.md)): the same session,
  re-distributed, at index 1 across two device joins.
- **What the bench does not reach:** key groups of production size (199 seats, about 100 commits a
  day in a growing community), a `mls.bin` days behind (the background never persists commits, so
  every salon push re-applies every commit since the app last ran), multi-MB states,
  `MlsStateLock` contention from bursts of commit pushes (`tryLock(5 s)`, a timeout reads as
  `Refused` or `UNKNOWN`), the 5 s read timeout on `mls/push/commits`, and the NSE's memory and time
  limits.
- **Those candidates are not separated by today's report.** `[PUSH_BLIND]` carries `missing` and
  `held` only. The `refused=<reason>` report and the native `CanariFCM` ring in the in-app export,
  both being built in another pull request, are the evidence that names the branch. Read them
  before building anything here.

**Re-read 2026-11-12 (batch 22): the report shipped.** The `refused=` report and the counted
fallback (#3027) and the resume fix (#3030) first ship in the stable `v1.6.5` (`git tag
--contains`), so step (1) is readable now; nothing here is built until it has been read.

**Owed.** (1) One `GROUP BY refused` over a day of `[PUSH_BLIND]` on
production. (2) The bench run again with a key group of real size: the rig's `newdevice.mjs`
cycles add a commit each. (3) The iPhone as the receiver: the same two runs with the NSE.

The frames a newcomer received sealed before its own join (the other half of the 2026-11-04 report,
`past-epoch-application` right after an external join) are withheld by chat-delivery since
2026-11-04 ([chat-delivery](../services/chat-delivery.md#who-a-frame-is-queued-for-and-who-owns-the-gateways-routing-set)).

**Step (1) read on production 2026-11-14** (15.5 hours after the `v1.6.11` deploy, a day was not
readable - [logging](../infrastructure/logging.md#reading-an-archive)): 6 `[PUSH_BLIND]` lines, 3
accounts, ONE salon, all within 15 minutes; every one `missing=seed refused=none` (5 iOS
`held=false`, 1 Android `held=true`). `refused=none` means no open ran: the seed was not there to
open, so the failing branch is the seed's absence, not a refusal by the open. Steps (2) and (3) stay
owed.

**Step (1) again, 2026-11-14, 09:11-10:40 UTC after the `1.6.12` deploy:** 2 `[PUSH_BLIND]` lines,
both iOS, `missing=seed held=false refused=none`, same shape as the 6 above. Still no `refused=`
value other than `none` on production: the failing branch remains the seed's absence.
