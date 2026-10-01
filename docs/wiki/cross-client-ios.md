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
| `tools/ios-device/ios.mjs` | `state`, `active`, `terminate`, `locked`, `unlock`, `flat` (now with each element's `label` and `value`, which is how a switch is read), `longPressAt`, and since C1 `perform` (one W3C touch sequence), `webviewRect`, `openUrl`, `type -` (stdin, for a secret); asking about the app, swiping, typing or opening a URL never launches it |
| `webkit-input.mjs` (C1) | the WebView's input: under `CANARI_PHONE=ios`, the connection `cdp.mjs`'s `connect()` opens on `PORTS.I1` performs every `Input.*` frame as a WDA touch or key - see [C1](#c1---the-input-seam-done) |
| `phone-ios.mjs`, second half | the WDA-only observables O3, O6-O11 below, each ending in a proof read back from the device |
| `login.mjs --device I1` | the launcher click through C1, then `signInThroughSheet` (O9); the proof is the app holding a session, as on every other client |
| `iosbench.mjs` | the app asked about its own native stores (O5, O15) - spawned, so `phone-ios.mjs`'s readers stay synchronous |
| `webkit-files.mjs` | a fixture into the composer on WebKit (O14), used by `chat.mjs attachFiles` |

**The bench before a run**: a BENCH build (`ios.yml` with `local_url` - it adds `tauri/devtools`, so the
WKWebView is inspectable; a store build is not), `python tools/ios-device/wda-daemon.py`,
`pymobiledevice3 webinspector cdp --port 9444`, then `bun phone.mjs`-style arming through `--device I1`.

## C1 - the input seam (DONE)

`cdp.mjs`, `chat.mjs`, `comm.mjs`, `pin.mjs` and the rows type with `Input.insertText` and click with
`Input.dispatchTouchEvent`/`dispatchMouseEvent` - ~70 call sites - and the WebKit protocol has no `Input`
domain. **So the seam is the connection, not the callers**: `connect()` wraps `send` for the one
connection that is the iPhone (`CANARI_PHONE=ios` AND the socket's port is `PORTS.I1`), and
`webkit-input.mjs` performs each `Input.*` frame on the device. With `CANARI_PHONE` unset the predicate
answers before reading anything and every connection keeps the plain CDP `send` (`cx.webkitInput ===
false`, asserted); under `CANARI_PHONE=ios` the browsers keep theirs too, since W2 stays one.

- **A click** is a WDA touch at the element's SCREEN point: the WebView's rectangle from WDA (re-read
  when the layout viewport changes size - the keyboard shrinks the frame), plus the content inset UIKit
  adds above the page (the frame height `documentElement.clientHeight` does not fill: 47 pt on the iPhone
  12 when the shell is not edge to edge, 0 when it is), plus the visual viewport's offset and scale.
  `armClickRecorder` still names what took the click, so a wrong origin fails as `click missed its
  target` with the point - which is how the first live run checks the geometry.
- **A touch is recorded and replayed at its release**, as one W3C gesture with the durations the caller
  spent: a tap stays a tap, `longPressBubble`'s 700 ms stays an OS long press (on the iPhone the CDP
  branch IS the real finger), `dragTo` keeps its moves. WDA has no finger that stays down between two
  requests, so `holdAndSlide({ release: false })` REFUSES on the iPhone (`WebKitInputUnsupported`), and
  `dragTo`'s target centre, re-read "after the lift", is read before the finger lands there.
- **Text** is WDA keys, one character each, in process (never an argv). An empty `insertText` deletes
  only a selection, as in Chrome. Enter and Backspace map to Return and Delete; **Escape, Tab and the
  arrows refuse** - the soft keyboard has none, and a key reported sent that did nothing is a gesture
  that lies. A row that closes a sheet with Escape taps its close control on the iPhone.
- **A hover** (`parkPointer`, a `mouseMoved` with no button) performs nothing: a touch screen has no
  pointer.
- `chat.mjs`: `isPhone` covers I1 (`isIosApp`), the `adb input swipe` branch is Android's only
  (`isAndroid`), and `goto`'s reload refusal and `openDM`'s parking apply to I1 as to A1 - the same Tauri
  shell, the same PIN re-lock.

Pinned by `archive/webkit-input-selftest.mjs`; **nothing has run on the iPhone**.

## What is owed

**Each row is a mechanical port**: `import phone from '../phone-any.mjs'`, `WEBVIEW_MATCH` and
`PORTS.I1` instead of `'tauri.localhost'` and `PORTS.A1`, `syslogSince` for `logcatSince`. And the
row-specific observables below - O3 and O6-O11 are functions of `phone-ios.mjs` now, each ending in a
proof read back from the device and pinned by `archive/ios-observables-selftest.mjs` over a scripted
iPhone. Their LABELS are the expected ones (French first, the bench phone's language) and the first live
run re-pins them.

| Id | Observable | Route on the iPhone | State |
| --- | --- | --- | --- |
| O1 | the console | `webkit-console.mjs` | DONE |
| O2 | the shade | Notification Center through WDA | DONE |
| O3 | network conditions on the phone | `setAirplaneMode(on)`: Control Center, airplane AND Wi-Fi read back (iOS restores a Wi-Fi turned on inside airplane mode, and Wi-Fi is the estate's network); `setLinkConditioner(profile \| null)`: Settings > Developer > Network Link Conditioner, its Enable switch read back - `Network.emulateNetworkConditions` does not exist in WebKit | DONE, fixtures only; the profile row is tapped, not proven |
| O4 | APNs delivered | `requireFreshFcmLink` under `CANARI_PHONE=ios` proves the receipt WITNESS instead (the syslog capture running and receiving, else `SETUP-FAILED`); after the wait the row records `apnsEvidence(since)` (`apsd` lines naming the app) beside the server's `[PUSH_SEND] ... platform=ios` | DONE, unrun |
| O5 | the native stores | `bench_native_store`, a command compiled into the BENCH build only, asked through the WebView (`iosbench.mjs`): `nativeResidue`, `nativeFootprint`, `graineMirrorSessions`, `forgetGraineMirror` answer as on Android, plus `mlsStateIdentity`, `snapshotMlsState`, `restoreMlsState`, `damageMlsState('truncate' \| 'flip')` | DONE, unrun |
| O6 | user force-quit | `forceQuit()`: the app switcher (slow drag from the bottom edge, held) and the card flicked off, then PROVEN dead - on iOS it stops background pushes, so it is LIFE-3's subject, not `forceStop` | DONE, fixtures only |
| O7 | system settings | `openSettings(path)` from the ROOT (Settings ended first), `openAppSettings()` (Apps > Canari on iOS 18, Canari on the root before), `setNotificationsAllowed(on)` read back | DONE, fixtures only |
| O8 | reboot | `reboot()`: `pymobiledevice3 diagnostics restart`, usbmux SEEN losing the phone (a restart not taken is refused) and finding it again; stops at Before First Unlock - the first unlock is a human's, then `wda-daemon.py` | DONE, fixtures only |
| O9 | a fresh device | `freshInstall(ipa)`: uninstall proven by `apps list`, `sign-install.mjs`, installed proven; `signInThroughSheet` answers the consent alert and the IdP's two stages with RETURN ([phone-comparison](phone-comparison.md)), the password through stdin; `login.mjs --device I1` drives it | DONE, fixtures only |
| O10 | a cold deep link | `openDeepLink(url)`: WDA `POST /session/:id/url` with NOTHING launched first (`cold` reported), Safari's "Ouvrir" answered, done when the app is in front | DONE, fixtures only |
| O11 | notification actions | `notificationAction(needle, 'reply' \| 'mark_read', { text })`: long press in Notification Center, the action by the title in the app's own `Localizable.strings`, a reply typed and sent; taken = the button gone | DONE, fixtures only |
| O12 | calls | CallKit's UI and the mic/camera alerts through WDA; the server's `[apns-voip]` lines | owed (calls are held off) |
| O13 | how a notification is filed | `interruptionLevels(since)`: the `filed interruptionLevel=` line the extension (`by: 'nse'`) and the app's own poster (`by: 'app'`) write on a BENCH build - `timeSensitive` for a mention, `active` for a message, iOS having no channels | DONE, unrun |
| O14 | a file into the composer | `chat.mjs attachFiles` on a WebKit page: the page builds the `File`s and fires `change` on the composer input (`webkit-files.mjs`) - the app's path from the pick on; the system picker itself still needs WDA | DONE, unrun |
| O15 | the refresh credential | `clearRefreshCredential()`: `tauri://localhost` keeps it in `auth-native.json`, not a cookie ([sessions](sessions.md)); erased through the store plugin's LIVE instance, so the running app reads it gone | DONE, unrun |

### The bench observables: what they are, and why a store build cannot carry them

O5, O13 and O15 are product code, so they are **compiled in, never switched on**. A `local_url`
dispatch of `ios.yml` - the bench build, which already adds `tauri/devtools` and refuses `publish` -
adds the Cargo feature `bench-observables` (the `bench_native_store` command,
`src-tauri/src/commands/bench.rs`) and the build condition `CANARI_BENCH` (the filing lines, in
`NotificationService.swift` and `canari_push.mm`). No release path sets either.
`.github/scripts/bench-observables.sh` then reads the BUNDLE: every store archive must contain none
of the three markers, and every bench build must contain all three - the second half is what stops
the first from passing by searching the wrong place. O14 needs no product code; its gate is that
only a bench build is inspectable at all.

**What the app's answers cost, and Android's do not.** `run-as` reads a dead app's files; here the
APP answers, so every native reader needs the app **running, in front, with the bridge up**, and
answers `{ error }` otherwise - it never launches the app to ask, since a launch re-mirrors the
stores it is reading. `graineMirrorSessions` counts the App Group's copy, the one the extension opens
a push against; `forgetGraineMirror` removes both copies, because the app re-mirrors its own into the
App Group at its next resign-active. `damageMlsState` is refused by the app without a snapshot.
A damage or restore changes the FILE: the row then `forceStop()`s and relaunches, and reads
`mlsStateIdentity()` to prove the reload took it.

**What the first live session must confirm** (each shape below is the expected one, pinned by
`phone-ios-selftest.mjs`, never yet read off the device):

1. The bridge answers `/json/list` with a `tauri://localhost` page and `iosbench.mjs` gets a value
   back (the call is started and polled through `window.__canariBench`, so it does not depend on
   whether the bridge forwards `awaitPromise`).
2. `nativeStore('list')` names a non-null `group` - the App Group path through the Objective-C
   runtime - and `nativeResidue()` on a signed-in phone is non-zero.
3. After `damageMlsState('flip')`, `forceStop()`, `launch()`, `mlsStateIdentity()` still shows the
   damaged digest: nothing in the dying app wrote `mls.bin` back first.
4. A mention and a plain message each produce one `filed interruptionLevel=` line in `syslogSince`,
   under the extension's process name, and NOTIF-16's two levels differ.
5. `attachFiles` on the iPhone stages the fixture (the composer shows its tray): WebKit accepts
   `input.files = dataTransfer.files`.
6. `clearRefreshCredential()` answers `{ had: true, present: false }` and the next refresh is a
   clean re-login (TAB-6).
7. `syslogWitness()` grows within its 10 s on an idle phone, and `apnsEvidence` counts the `apsd`
   line of a delivered push - the `apsd` wording itself is still the expected one.

**What the first live session must confirm before any row's verdict is believed** - each is a shape
the fixtures assume:

1. **C1's origin**: one `realClick` on a known control (the bottom nav) with the shell edge to edge AND
   with the keyboard up; the recorder must name the control, not `click missed its target`. That
   settles the WebView rect WDA returns (`XCUIElementTypeWebView`), the content inset, and whether the
   keyboard resizes the frame or only the visual viewport.
2. **C1's keys**: WDA `/wda/keys` reaches a WebView field focused by a WDA tap (the composer, a PIN
   field), and Return submits where Enter did.
3. **C1's long press**: `longPressBubble` opens the sheet with the replayed 700 ms press (MUT-18).
4. **The labels**: Control Center's airplane and Wi-Fi switches and their `value`; the switcher card's
   label and type; Settings' "Apps" row (iOS version), "Autoriser les notifications", the Developer
   menu's NLC rows; the consent alert and the IdP host on the sheet; Safari's "Ouvrir"; the expanded
   notification's action buttons.
5. **O8**: `pymobiledevice3 diagnostics restart --udid` is taken over usbmux, and how long the phone
   stays unlisted.

## Every row

`a` = runs with the adapter (once C1 lands), `b` = needs the observable named, `c` = what the row
tests does not exist on iOS. A `b` row whose observables are all `DONE` above is ported like an `a`
row once C1 lands and the live confirmations above hold; its class here stays `b` until then.

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
