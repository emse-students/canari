## P1 - iOS notifications show no content

Reported 2026-11-01 by the owner for a real user on iOS `1.5.3`: iPhone message notifications show
no content, reportedly the generic "Nouveau message", and earlier versions showed it (a
REGRESSION, per the user). The user's in-app log had no `[FCM_CACHE]` line.

**Re-read later the same day: the banner is `Nouveau message de <name>`, not `Nouveau message`**,
app in the background or killed. That text is the extension's own fallback
(`notif.message.from`, `fallbackText` in `canari_NSE/NotificationService.swift`); the server's
alert body is the bare `Nouveau message`. So on that phone the extension IS loaded and runs, and
falls back on a handled branch: the deployment-target cause below is ruled out for this user. The
`1.5.3` build carries no `[NSE_OUTCOME]` log; the cause is read from the first stable carrying it
(the user receives a few messages backgrounded, then killed, and exports the log).

**The chain, read link by link (2026-11-01, mechanism in
[mobile](../frontend/mobile.md#what-the-extension-did-in-the-apps-log-2026-11-01)):**

| Link | Verdict |
| --- | --- |
| Server APNs payload: `mutable-content: 1`, alert fallback, the fields the extension reads (`push-payload.ts` `buildApnsRequest`, sent per iOS token in `messaging.service.ts`) | fine; unchanged across `v1.4.0..v1.5.3` |
| Extension embedded, signed, own bundle id and profile (`CanariNotifications`, `fr.emse.canari.notifications`; `ios.yml` installs and maps three profiles; `ios-extensions.sh` fails a build without both appex) | fine |
| Extension deployment target | **broken since 2026-07-21: 18.2 against an app installing from 16.0** - never run on iOS 16.0-18.1. Fixed in this change. Not a regression, so it explains the user only if their iPhone is below 18.2 |
| App Group and keychain group shared (`group.fr.emse.canari` on both; the background key copy written with that access group) | fine by reading |
| What the extension decrypts with: `mls.bin` mirror + background key copy + Rust FFI, read-only | unknown on a device: `mls.bin` is read up to three times per push (direct, locality, catch-up), each a full decrypt and deserialisation, and `v1.5.0` added load-time work over every leaf (device pins). A footprint past the extension's limit is a kill, which shows exactly the server's "Nouveau message" |
| Cache the app reads (`fcm_message_cache.ndjson` via the App Group) | consistent with either cause: no decrypt writes nothing, and since `v1.5.0` a line also needs the native cache key |
| The tap | **broken when the extension did not run**: message and salon pushes carry no `deepLink`, the extension writes it, so the tap opened the app on nothing. Fixed: `CanariTapDeepLink` |

**What decides between the causes is the banner text and the new log.** `Nouveau message` exactly =
the extension never handed content back (not loaded, killed, crashed); `Nouveau message de <name>`
= it ran and fell back, and its `[NSE_OUTCOME]` line names why.

**Owed, on the iPhone 12 bench (production build carrying this change, owner's latitude):**

1. Note the phone's iOS version (Settings > General > About). Install the TestFlight build carrying
   this change; open it once, unlock, then send it to the background and lock the phone.
2. From another account (a phone or the web, any account in a 1:1 conversation with the bench
   account), send three texts: one in the 1:1, one in a group of three or more, one in a salon.
   Then force-quit Canari on the iPhone (swipe it away) and send two more in the 1:1.
3. Read each banner: name in the title, the TEXT in the body = pass; `Nouveau message` alone or
   `Nouveau message de <name>` = fail, and which of the two it is matters (above).
4. Console.app on the tethered Mac, device selected, filter `[CanariNSE]` (process
   `CanariNotifications`), streaming before the sends. Per push expect `didReceive type=message`,
   then either `outcome=decrypted ... peakMB=<n>` or a fallback line naming the branch, and no
   `time expired`. A `didReceive` with no `outcome=` line after it is a kill: add a filter on
   `jetsam` / `CanariNotifications` in the same window for `EXC_RESOURCE` / `per-process-limit`.
   No `didReceive` at all = the extension is not loaded (iOS below its target, or not embedded).
5. Tap one of the banners with the app killed, one with it backgrounded, one in the foreground:
   each must open its conversation (Console: `[CanariPush] notification tap type=message
   deepLink=fr.emse.canari://chat/[1 seg]`).
6. Open Canari, export the log: `[NSE_OUTCOME] {"v":1,...,"outcome":"decrypted",...}` per push,
   then the summary line `[NSE_OUTCOME] N notification(s) handled by the extension since the last
   read: decrypted=N`. A `killed` line names the `stage` and `peakMB` the run reached; a
   `fallback` names its `cause`. Record `peakMB` and `stateKB` here, with the account's group count.

**Owed, the outcome log's own three rows (same bench, a `local_url` or TestFlight build, Xcode on
the tethered Mac):**

7. **A crash is exactly one `killed`.** Send one 1:1 message; while Console shows `didReceive`,
   Xcode > Debug > Attach to Process > `CanariNotifications`, then Stop (the debugger's SIGKILL).
   Open Canari: the log must hold EXACTLY ONE `"outcome":"killed"` line for that push, with the
   stage it reached, and no other line with its `pid` and `at`.
8. **An expiry is exactly one `expired`.** Attach the same way with a breakpoint on
   `handleMlsMessage`, hold it 40 s, continue. The banner must still arrive (the best attempt), and
   the log must hold EXACTLY ONE `"outcome":"expired"` line whose `cause` is the stage, and no
   `killed` for that run on any later drain (the marker is removed under the run's lock and never
   rewritten after `end`). If iOS does not call the expiry while the debugger holds the process,
   say so here and use a `local_url` build against a server held silent for the proto fetch.
9. **`kill(pid, 0)` answers `ESRCH`, not `EPERM`, from the app's sandbox.** Row 7's drain decides
   it: a `killed` line proves `ESRCH`. A log line `[NSE_OUTCOME] pid liveness not provable
   errno=Some(1)` with the marker left in place means the sandbox hides the answer: kills are then
   counted only after a reboot (the marker's `boot` stamp) or lost to the 64-marker cap, and the
   proof must move to a lock the run holds for its life (released by the kernel at its death).

Closed when a release carrying this change shows content on the bench and the user's phone, or
the outcome log names a cause that then gets its own fix.

**Not built, decided here: opening AT the tapped message.** The owner asked (2026-11-01) for a tap
to scroll to the message; today it opens the conversation at its unread marker (by design, recorded
in [mobile](../frontend/mobile.md#what-every-notification-opens-and-what-was-measured-2026-10-08)).
The extension knows the decrypted `messageId` and could write `chat/<groupId>?m=<id>`; the route
table (`deepLinkRoutes.ts`), `notifNav` and `ChatArea.navigateToMessage` would carry it, and a tap
whose message has not synced yet must fall back to the marker. Android owes the same.
