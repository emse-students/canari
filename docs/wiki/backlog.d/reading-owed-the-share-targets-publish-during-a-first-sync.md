## Reading owed - the share targets published twenty-three times in an account's first sync: which id flaps

target: 1.7.0

**Seen** on `1.7.0-alpha.12`, Mi 9T, dev, after a sign-out and a sign-in of a second test account
([readings](../device-verification.md#the-phone-and-web-readings-of-2026-11-18-s6-170-alpha12-live-moderations-last-halves-the-reel-card-overlays-the-birthday-morning)):
23 `publishShareTargets: 5 target(s)` in about 27 s, `1 removed` on most of them. `syncShareTargets`
republishes whenever the ordered ids and labels of the top five change, so each call is a real change
of the list, and `removed` counts ids the previous set held that the new one lacks (a label-only
change removes none).

**Built:** each publish now says HOW it differs from the one before, in the in-app log
(`describeShareTargetsChange`, `sharing/shareTargetsNative.ts`):
`[ShareTargets] publishing (conversations changed): added [<id8>], removed [<id8>], N relabelled, reordered|same order`
(id prefixes, never a name). No behaviour changed: the ids were never read, and the two possible
causes have different fixes ([sharing](../frontend/sharing.md)).

**The reading that closes it:** on the Mi 9T, on the next pre-release, sign a second test account in and
read the `[ShareTargets] publishing` lines of its first sync (`adb logcat` or the in-app log).
- The SAME id in `removed` and later in `added`: the set FLAPS, the order of the list during the sync is
  not a stable function of what has arrived (a conversation whose name is not yet resolved is skipped
  and returns once it is, taking its place back) - fix the order, in `selectShareTargets`.
- Only `added` ids, never one that returns: the set walks forward - publish from a settled list, the
  sync's own end, never a timer.
- Lines that are all `relabelled`: the label (a salon's community suffix, a resolving name) is
  unstable - fix where the label is read.

The test to write with the fix: one sync replaying N conversations publishes a number of times bounded
by the changes of the final top five. Delete the entry with the fix.
