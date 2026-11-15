## Reading owed - the row a push creates carries the GROUP's name

target: 1.7.0

**What is built:** the row a push creates carries the GROUP's name

**The reading that closes it:** HARDWARE, both platforms, ONE case (a push placeholder), on an APK built from this tree ([check C](../device-verification.md#c-the-row-a-push-creates-carries-the-groups-name---owed-on-both-platforms))

**Triage 2026-11-14: Mi 9T about 15 min, iPhone about 15 min** (check C of [device-verification](../device-verification.md#c-the-row-a-push-creates-carries-the-groups-name---owed-on-both-platforms), a store build now serves it, so no local APK is needed).

**Mi 9T half, READ 2026-11-15 on dev (`1.6.12-alpha.2`, build `100601202`; alpha on the phone, the beta web seat as the peer).** Check C by its procedure: the app killed (HOME, `am kill`, proved dead), beta created a two-member group "mi9t banc C" and added alpha; the push woke the phone, which joined in the background (`processReceivedWelcomeBackground: ✓ group joined group=8e9fb97e`, `markMembershipActive: HTTP 201`); beta then sent one message, drawn `groupConversation=true titled=true` and cached (`writeFcmCache: ✓ ... groupId=8e9fb97e`). At the next open, read before the sync finished, the row read "mi9t banc C" (the group, not "Canari Test Beta"), with no `[DISCOVERY] ... relabelled` line, so the cache label itself was right. **Left: the iPhone 12 half, about 15 min.**
