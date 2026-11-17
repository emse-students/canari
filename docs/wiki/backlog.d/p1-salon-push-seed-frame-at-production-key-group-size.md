## P1 - a salon push's seed frame opened against a key group of production size, on the bench (2026-11-17)

target: 1.7.0

**Why it is its own entry.** The P1 "blind salon banners, the failing branch is unnamed" was answered
by [channel-encryption section 27](../protocols/channel-encryption.md#27-the-iphone-held-two-seed-mirrors-and-the-one-without-the-extensions-seeds-won---fixed-2026-11-17)
(the iPhone's two seed mirrors), and closed. One of its owed steps was never run and section 27 does
not cover it: the bench reached the seed frame's commit catch-up only with a key group of a few
devices, at epochs 6 to 9. Production key groups hold up to about 150-400 active devices and gain
commits daily; a `mls.bin` days behind re-applies every commit since the app last ran, in memory, on
every salon push (the background never persists commits), under `MlsStateLock` (`tryLock(5 s)`) and
the 5 s read timeout of `mls/push/commits`, and on iOS inside the extension's memory and time limits.

**Owed, in order.** (1) On the rig, grow a dev key group to a real size with `newdevice.mjs` cycles
(each adds one commit), leave the Mi 9T killed across tens of commits, then send a message of a
session minted after them: the banner shows the text, and the catch-up's duration and commit count
are read from `[NATIVE_PUSH]`. (2) The same on the iPhone 12 with the extension as the receiver, its
memory peak read from the extension's outcome line. A blind banner in either is a defect to build
against, named by its log line.
