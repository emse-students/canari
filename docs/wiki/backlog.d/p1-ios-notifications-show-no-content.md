## P1 - iOS notifications show no content

Reported 2026-11-01 by the owner for a real user on iOS `1.5.3`: iPhone message notifications show
no content, reportedly the generic "Nouveau message", and earlier versions showed it (a
REGRESSION, per the user). The user's in-app log had no `[FCM_CACHE]` line.

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

Closed when a release carrying this change shows content on the bench and the user's phone, or
the outcome log names a cause that then gets its own fix.

**Not built, decided here: opening AT the tapped message.** The owner asked (2026-11-01) for a tap
to scroll to the message; today it opens the conversation at its unread marker (by design, recorded
in [mobile](../frontend/mobile.md#what-every-notification-opens-and-what-was-measured-2026-10-08)).
The extension knows the decrypted `messageId` and could write `chat/<groupId>?m=<id>`; the route
table (`deepLinkRoutes.ts`), `notifNav` and `ChatArea.navigateToMessage` would carry it, and a tap
whose message has not synced yet must fall back to the marker. Android owes the same.
