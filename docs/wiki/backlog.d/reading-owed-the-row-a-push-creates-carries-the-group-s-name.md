## Reading owed - the row a push creates carries the GROUP's name

target: 1.7.0

**What is built:** the row a push creates carries the GROUP's name

**The reading that closes it:** HARDWARE, both platforms, ONE case (a push placeholder), on an APK built from this tree ([check C](../device-verification.md#c-the-row-a-push-creates-carries-the-groups-name---owed-on-both-platforms))

**Triage 2026-11-14: Mi 9T about 15 min, iPhone about 15 min** (check C of [device-verification](../device-verification.md#c-the-row-a-push-creates-carries-the-groups-name---owed-on-both-platforms), a store build now serves it, so no local APK is needed).

**iPhone 12 half, DELETED 2026-11-15 (measured on dev, TestFlight `1.6.12-alpha.2`):** the placeholder row cannot be created on iOS. The delta web seat made the group "Banc C quinze", added gamma with the app killed, and sent one line: both pushes ran the NSE to `group not joined here group=a38a46ca -> generic fallback` (`outcome=fallback cause=group-absent`), and no `writeFcmCache` line was written, because the extension decrypts only a group the app has already joined, and iOS joins at the next foreground, which writes the row with its name first. After the foreground the row read "Banc C quinze" with its unread line. The cache placeholder this check is about is an Android path only. **Left: the Mi 9T half.**
