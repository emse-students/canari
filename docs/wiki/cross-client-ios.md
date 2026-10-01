# The cross-client campaign on the iPhone

**What it takes to run the [board](cross-client-testing.md)'s ladder on the iPhone 12 as well as on
the Mi 9T: every row classified, the adapter that exists, and the observables still owed.** Written
2026-10-01 with the iPhone in use by another session, so **nothing here has run on the device yet** -
every shape the adapter reads is the expected one, pinned by `archive/phone-ios-selftest.mjs`, and the
first live session re-pins it. The campaign's design is [cross-client-campaign](cross-client-campaign.md);
the bench build is [mobile](frontend/mobile.md#a-build-for-the-phone-on-the-bench).

## The seats

- **`I1` is the iPhone, logged in as the OWNER** - the device name carries the platform, as `A1` does
  (`phone-platform.mjs`). `names.mjs` gains `PORTS.I1` (the inspector bridge, 9444), `ORIGIN.I1`
  (`tauri://localhost`), `ACCOUNT_OF.I1` and `UDID_OF.I1` (template: `names.example.mjs`).
- **A phone row** (`+A1`, `+push`) runs with I1 in A1's seat.
- **A browser row** (`W1 W2`) runs with I1 in **W1's** seat - the owner's client becomes the iOS app;
  W2 stays the peer's browser. A row with no I1 in it measures nothing about iOS.

## What exists (this change)

| Piece | What it gives a row |
| --- | --- |
| `phone-ios.mjs` | `phone.mjs`'s interface, name for name and sync for sync: lifecycle over WDA (`apps/state`, `activeAppInfo`, `terminate`), Notification Center as the shade (`notifications`, `awaitNotification`, `tapNotification`, `undecryptedInShade`, a `deviceNowMs` floor), the syslog as logcat (`startSyslog`, `console_`, `syslogSince`, `apnsReceipts`), `ensure` against the WebKit inspector bridge, `unlockPin`. What has no counterpart throws `NotOnIos` naming the iPhone's route |
| `phone-any.mjs` | `CANARI_PHONE=ios` picks `phone-ios.mjs`, unset keeps `phone.mjs`; a row switches by its import line |
| `device.mjs` | `--device I1` arms the iPhone (`armIfPhone`), so the atoms resolve it like A1 |
| `webkit-console.mjs` + `watch.mjs` | the iPhone's console (`Console.messageAdded`) reaches the classifier as `Log.entryAdded` - without it every iPhone window would read clean by construction |
| `tools/ios-device/ios.mjs` | `state`, `active`, `terminate`, `locked`, `unlock`, `flat`, `longPressAt`; asking about the app or swiping never launches it |

**The bench before a run**: a BENCH build (`ios.yml` with `local_url` - it adds `tauri/devtools`, so the
WKWebView is inspectable; a store build is not), `python tools/ios-device/wda-daemon.py`,
`pymobiledevice3 webinspector cdp --port 9444`, then `bun phone.mjs`-style arming through `--device I1`.

## What is owed

**C1 - the input seam, and it gates nearly every row.** `cdp.mjs` and `chat.mjs` type with
`Input.insertText` and click with `Input.dispatchMouseEvent`/`dispatchTouchEvent`; the WebKit protocol
has no `Input` domain. On a WebKit client the gestures must become WDA touches at the element's own
rectangle (CSS px are points on an edge-to-edge WKWebView) and WDA keys for text. It is one seam in two
files, not a per-row change - but it is the core of the rig, so it is its own change.

**Then each row is a mechanical port**: `import phone from '../phone-any.mjs'`, `WEBVIEW_MATCH` and
`PORTS.I1` instead of `'tauri.localhost'` and `PORTS.A1`, `syslogSince` for `logcatSince`. And the
row-specific observables below.

| Id | Observable | Route on the iPhone | State |
| --- | --- | --- | --- |
| O1 | the console | `webkit-console.mjs` | DONE |
| O2 | the shade | Notification Center through WDA | DONE |
| O3 | network conditions on the phone | Control Center airplane mode through WDA (offline); the Developer Network Link Conditioner (throttle) - `Network.emulateNetworkConditions` does not exist in WebKit | owed |
| O4 | APNs delivered | per row: the server's `[PUSH_SEND] ... platform=ios` line + `apnsReceipts()` (syslog `apsd`); replaces `requireFreshFcmLink`, since APNs has no socket to renew - `fcmlink.mjs` needs the iOS branch | half: `apnsReceipts` DONE |
| O5 | the native stores | the MLS state and the Graine mirror are in the App Group container `group.fr.emse.canari`, which no lockdown service vends - a BENCH-only app command reporting counts (and taking/restoring/damaging a snapshot) through the WebView | owed, product code |
| O6 | user force-quit | the app-switcher swipe through WDA - on iOS it stops background pushes, so it is LIFE-3's subject, not `forceStop` | owed |
| O7 | system settings | the Settings app through WDA (notification permission) | owed |
| O8 | reboot | `pymobiledevice3 diagnostics restart`; the first unlock is a human's | owed |
| O9 | a fresh device | uninstall, `sign-install.mjs`, sign-in through ASWebAuthenticationSession by WDA ([phone-comparison](phone-comparison.md)) - `login.mjs` needs that branch | owed |
| O10 | a cold deep link | WDA `POST /session/:id/url` | owed |
| O11 | notification actions | long-press the Notification Center element (`longPressAt`), then reply / mark read | owed |
| O12 | calls | CallKit's UI and the mic/camera alerts through WDA; the server's `[apns-voip]` lines | owed (calls are held off) |
| O13 | how a notification is filed | the NSE's `interruptionLevel` (iOS has no channels) - a syslog line from the NSE | owed |
| O14 | a file into the composer | WDA through the system picker with fixtures in Photos/Files | owed |
| O15 | the refresh credential | `tauri://localhost` carries it in `X-Canari-Refresh`, not a cookie ([sessions](sessions.md)) - cleared through the WebView / O5 | owed |

## Every row

`a` = runs with the adapter (once C1 lands), `b` = needs the observable named, `c` = what the row
tests does not exist on iOS.

| Rows | Class | On the iPhone |
| --- | --- | --- |
| SETUP-1, SETUP-2 | a | `ios.yml` `local_url` + `sign-install.mjs`; uninstall with `pymobiledevice3 apps uninstall` (the jniLibs rescue is Android's) |
| SETUP-3 | a | `startSyslog()` |
| SETUP-4, SETUP-5, SETUP-9 | a | the browsers' own setup, unchanged |
| SETUP-6 | b | O9 |
| SETUP-7, SETUP-8 | b | O5 |
| MSG-1, MSG-1-cold, MSG-1b, MSG-3, MSG-6, MSG-7, MSG-9 | a | I1 as W1 (MSG-9 cuts W2, a browser) |
| MSG-2, MSG-5, MSG-8, MSG-8b | a | I1 as A1 |
| MSG-4 | b | O14 |
| MSG-10 | b | O3 |
| TYPE-1, TYPE-2, TYPE-3, TYPE-4, TYPE-5 | a | TYPE-3's tab kill is `forceStop()` |
| READ-1, READ-2, READ-3, READ-4, READ-5, READ-6, READ-7, READ-8, READ-9, READ-10 | a | READ-3's focus is the app in front; READ-5 stays `SKIPPED` (four readers) |
| MUT-1, MUT-2, MUT-3, MUT-4, MUT-5, MUT-6, MUT-7, MUT-8, MUT-9, MUT-10, MUT-11, MUT-12, MUT-13, MUT-14, MUT-15, MUT-16, MUT-17, MUT-18, MUT-19, MUT-20 | a | the phone's toolbar is the long-press sheet (C1 with `longPressAt`); MUT-20 stays `SKIPPED` |
| MUT-21 | c | the desktop HOVER bar is never rendered at phone width; the phone's sheet is MUT-18 |
| SEARCH-1, SEARCH-2, SEARCH-3, SEARCH-4, SEARCH-5, SEARCH-6 | a | |
| MENTION-1, MENTION-4, MENTION-5, MENTION-6 | a | |
| MENTION-2, MENTION-3 | b | O4 |
| FWD-1, FWD-2, FWD-4, FWD-5, FWD-5-repeat | a | |
| FWD-3 | b | O3 |
| GRP-1, GRP-2, GRP-3, GRP-4, GRP-5, GRP-6, GRP-7, GRP-8, GRP-9, GRP-10 | a | |
| COMM-1, COMM-2, COMM-3, COMM-4, COMM-5, COMM-6, COMM-7, COMM-8, COMM-9, COMM-10, COMM-11, COMM-12, COMM-13, COMM-15, COMM-16, COMM-17, COMM-19, COMM-20, COMM-21, COMM-22, COMM-23, COMM-24, COMM-25 | a | COMM-17's drag is C1 |
| COMM-14 | b | O4 |
| COMM-18 | b | O10 |
| DEL-1, DEL-2, DEL-3, DEL-5, DEL-6, DEL-9 | a | |
| DEL-4 | b | O14, O3 (throttle) |
| DEL-7 | b | O4 |
| DEL-8 | b | O5 |
| DEL-10 | b | O3 |
| TAB-1 | b | O4 - a backgrounded app is told by push |
| TAB-2, TAB-3, TAB-3b, TAB-5 | a | tab/browser closed = `forceStop()` + `launch()`; `Page.reload` exists in WebKit |
| TAB-4a, TAB-4b, TAB-4c | c | two tabs of one account: the app is one WebView |
| TAB-6 | b | O15 |
| TAB-7 | b | O3 |
| MULTI-1, MULTI-2, MULTI-5, MULTI-7, MULTI-8, MULTI-9, MULTI-10 | a | |
| MULTI-3 | b | O9 |
| MULTI-4 | b | O5 |
| MULTI-6 | b | O3 |
| LIFE-1 | a | |
| LIFE-2, LIFE-8 | b | O4 (LIFE-8's death is `kill()`, WDA terminate) |
| LIFE-3 | b | O6, O4 |
| LIFE-4 | c | Doze is Android's |
| LIFE-5 | b | O8, O4 - measures the NSE after a reboot; `CanariBootReceiver` is Android's |
| LIFE-6 | b | O3 |
| LIFE-7 | b | O7 |
| NOTIF-1, NOTIF-1b, NOTIF-2, NOTIF-3, NOTIF-4, NOTIF-4b, NOTIF-5, NOTIF-7, NOTIF-7b, NOTIF-7c, NOTIF-7d, NOTIF-9, NOTIF-12, NOTIF-13, NOTIF-14, NOTIF-15, NOTIF-17, NOTIF-17b, NOTIF-19, NOTIF-21 | b | O4 (NOTIF-15 without its Android channel clause; NOTIF-17 keeps its third-account block) |
| NOTIF-11 | b | O4, re-expected: a STACK of three under one `threadIdentifier`, not one InboxStyle notification |
| NOTIF-6, NOTIF-6b, NOTIF-6c, NOTIF-6d | b | O4, O11 - iOS has the reply and mark-read actions (`UNTextInputNotificationAction`) |
| NOTIF-8 | c | Doze is Android's |
| NOTIF-10 | b | O3, O4 |
| NOTIF-16 | b | O13 |
| NOTIF-18, NOTIF-20 | b | O4, O5 (the Graine mirror) |
| CALL-1, CALL-2, CALL-4, CALL-8, CALL-14, CALL-15, CALL-17, CALL-18, CALL-19, CALL-20 | a | |
| CALL-3, CALL-5, CALL-6, CALL-7, CALL-9, CALL-12, CALL-13 | b | O12 |
| CALL-10 | b | O12, O4 (a VoIP push) |
| CALL-11 | c | Doze is Android's |
| CALL-16 | b | O3 |
| HEAL-W1, HEAL-W2, HEAL-W3, HEAL-W4, HEAL-repair | b | O5 - the rewound client is I1 |
| HEAL-A1, HEAL-NEXT | a | the rewound client stays W2, a browser; I1 detects and repairs |
| HEAL-REVOKE-1, HEAL-REVOKE-6 | b | O5 |
| HEAL-REVOKE-2 | b | O5, O9 |
| HEAL-REVOKE-3, HEAL-REVOKE-4, HEAL-REVOKE-5, HEAL-REVOKE-7, HEAL-REVOKE-8 | b | O9 - the revoked iPhone signs back in |
| HEAL-REVOKE-9 | b | O3, O9 |
| HEAL-NEW-3, HEAL-NEW-4, HEAL-NEW-11, HEAL-NEW-13 | a | I1 is the responder |
| HEAL-NEW-5, HEAL-NEW-5b | b | O4 - a backgrounded or killed responder is woken by push |
| HEAL-NEW-0, HEAL-NEW-1, HEAL-NEW-2, HEAL-NEW-6, HEAL-NEW-7, HEAL-NEW-8, HEAL-NEW-9, HEAL-NEW-10, HEAL-NEW-12, HEAL-NEW-14, HEAL-NEW-15 | b | O9 - the fresh device is I1 |
| PIN-1, PIN-3, PIN-4, PIN-5, PIN-7, PIN-8, PIN-9, PIN-11 | a | PIN-8's outage is the estate's; PIN-9 is an app relaunch |
| PIN-2, PIN-6, PIN-10 | b | O5 |
| CORRUPT-3 | a | the vault blob is in the WebView's `localStorage` on the app too (`deviceKeyVault.ts`) |
| CORRUPT-1, CORRUPT-2, CORRUPT-4, CORRUPT-5, CORRUPT-6, CORRUPT-8, CORRUPT-9, CORRUPT-10 | b | O5 (CORRUPT-6 also O4) |
| CORRUPT-7 | c | the app keeps messages in SQLite, not the web IndexedDB store ([mobile](frontend/mobile.md#local-message-store)) |

**Counts (253 rows): 143 `a`, 102 `b`, 8 `c`.** The `c` rows are not iOS rows; each still tests a live
Android or web mechanism, so it leaves the iOS ladder and stays on the board.
