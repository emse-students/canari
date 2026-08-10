# Cross-client test campaign

Runbook for the manual-but-automated campaign that exercises Canari across **three simultaneous
clients** (two browsers, one Android device), targeting the three surfaces that carry the reported
irreproducible bugs: **messages, notifications, PIN**.

Sibling of [device-verification](device-verification.md). The difference is the question each
answers:

| Page | Question |
| --- | --- |
| [device-verification](device-verification.md) | Does a native path work **on hardware at all**? One device, one check. |
| this page | Does the system stay correct when **several clients, several lifecycles and a damaged store** meet? |

A check here that FAILS becomes a Work Package in `CLAUDE.md`, with its captured log. A check that
passes is recorded in the results table and never re-litigated.

> **Target is PRODUCTION** (`https://canari-emse.fr`). Real accounts, real messages, real FCM. There
> is no staging that carries push. Everything sent here is visible in the two accounts' real history.

**The rig itself is archived in the repo**: [`tools/cross-client-harness/`](../../tools/cross-client-harness/).
It is not run by CI and must not become part of it - it drives production with real accounts and
needs a phone attached. Its README covers the three clients, the launch flags that are load-bearing,
and the credential rule. This page is the campaign; that directory is the instrument.

## Where this campaign stands

_Read this section first. Everything below it is either the plan (sections 0-9) or the findings, in
the order they were made (section 10 onwards) - and the findings are long because each one is the
evidence for a shipped fix._

### Phases

| Phase | State | What is left |
| --- | --- | --- |
| **0 - setup** | **COMPLETE** | - |
| **MSG** - messages | **COMPLETE** | - |
| **FWD** - forwarding | **COMPLETE** | - |
| **TAB** - tabs and windows | **COMPLETE** | - |
| **LIFE** - Android lifecycle | **all but one** | **LIFE-5 (reboot)** - blocked, needs the user: the device asks for its unlock pattern and `wm dismiss-keyguard` cannot answer it. Pause and ask; do not work around it. |
| **NOTIF** - notifications | **partly** | NOTIF-2/3 (silent commit -> epoch gap), NOTIF-5 (mute), NOTIF-6 (quick reply from the shade, = check K). NOTIF-1 and NOTIF-8 are already answered by LIFE-8 and LIFE-4. |
| **HEAL** - does a broken group repair itself on the BROWSER? | **not started** | HEAL-W1..W4, section 7.1. Break = restore an older snapshot of `CanariDBMls_<dev>`; take the snapshot first. |
| **PIN** | **not started** | PIN-1..10 |
| **MULTI** - one user, two devices | **not started** | MULTI-1..6 |
| **CORRUPT** - deliberate store damage | **not started, deliberately last** | CORRUPT-1..10 |

Plus **check L** (a revoked device re-enrolling) at the very end, and restoring Firefox as the
phone's default browser (`cmd role add-role-holder android.app.role.BROWSER org.mozilla.firefox`) -
it was switched to Chrome only because Firefox exposes no CDP.

### What the campaign has produced

Eleven defects, every one of them found by a check or by the log of a check, and every one shipped.
The narrative for each is on this page; the rule each taught is in `CLAUDE.md`.

| Defect | Found by | State |
| --- | --- | --- |
| **WP-LOSS-1** - a reload rewinds the sender's ratchet, and the receiver silently drops the next message | FWD-3 / FWD-5, then reconciliation | sender half shipped + verified on prod; receiver half shipped; **Android half not yet exercised** |
| **WP-HIDDEN-1** - a backgrounded tab stops receiving, silently | TAB-4 | shipped, verified |
| **WP-MULTITAB-1** - two tabs of one account diverge their ratchet | TAB-4 | shipped, verified (9/9 where it lost 4 of 9) |
| **WP-ECHO-1** - the sender loses its OWN message across a reload | reconciliation | shipped; verified on the web (3 runs, 6 sends provably inside a drain) |
| **WP-PENDING-1** - a catch-up pull that can never make partial progress | LIFE-6 | shipped; **verification against a real backlog still owed** |
| **WP-PENDING-2** - a frame too far ahead was ACKed off the server as delivered | LIFE-6 | shipped, seen firing end to end |
| **WP-DRAIN-1** - a recovery awaited inside the drain, deadlocking it | verifying WP-HIDDEN-1 | shipped |
| **WP-GHOST-1** - a revoked device wrote its own routing membership back | the queue's size | shipped + verified on prod (98 210 rows -> 0) |
| **WP-NOTIF-1** - an Android notification not dismissed when read elsewhere | NOTIF-4 | shipped, verified on the device |
| **WP-DEEPLINK-1** - the deep-link plugin was never granted its permission | NOTIF-7 (killed) | shipped, verified on the device |
| **WP-RELOAD-DL-1** - a WebView reload replays the launch deep link | the observation log of a PASSING re-run | shipped, verified on the device |
| **WP-RETRANSMIT-1** - a decrypt-failure repair that fed itself | a user noticing a sync banner | shipped; see [the retransmission storm](#the-retransmission-storm-2026-08-07-a-repair-that-fed-itself) |

Three more were found here and are **open**, because each needs a decision rather than a patch:
**WP-KBD-1** (the composer behind the soft keyboard), **WP-DRAIN-2** (the inbound drain has no
watchdog), and the successor to WP-RETRANSMIT-1 below.

### The next piece of work, decided 2026-08-07

**WP-HIST-3 replaces the retransmission mechanism entirely, rather than being patched around it.**
The reasoning is in [the retransmission storm](#the-retransmission-storm-2026-08-07-a-repair-that-fed-itself):
`decrypt_failed` cannot name what it is missing, so it asks for a blind time window and every peer
answers with a broadcast - which is both the amplification class and the reason a loss noticed after
the sender reloaded is reported as unrecoverable. A manifest diff addresses by identity, reads the
durable store, and elects one responder. The campaign's remaining phases run **after** it, so they
test the mechanism that will actually ship.

## 0. Decisions taken 2026-08-05 - do not re-litigate

- **All channel traffic goes to a dedicated private channel** holding only the two test accounts
  (SETUP-9). Several checks send 30 messages in a row or 25 forwards in a loop; on a real channel
  those are real people receiving the burst. The dedicated channel is also what makes the commit
  tests (add/remove a member) possible without disturbing anyone - and NOTIF-2/3, the epoch gap, has
  no other way to run.
- **`claire.vanruymbeke` has no 2FA.** Only `jolan.boudin` does, and only once, at SETUP-4.
  Both browser profiles are persistent, so no code is ever asked for twice.
- **Wiping the phone is authorised.** SETUP-2 uninstalls, which erases `mls.bin` and the local
  history. That is not collateral damage: the re-enrolment path and MULTI-3 (history pooling into a
  device enrolled after the fact) are only testable from a clean device.

---

## 1. The three clients

| Id | What | Account | Driver | Session storage |
| --- | --- | --- | --- | --- |
| **W1** | Chrome, MCP-controlled | `jolan.boudin` | `chrome-devtools` MCP tools | persistent profile `~/.cache/chrome-devtools-mcp/chrome-profile` |
| **W2** | Chrome, second instance | `claire.vanruymbeke` | home-made CDP driver (below) | its own `--user-data-dir`, so an independent cookie jar |
| **A1** | Pixel 6a, Android 17 (SDK 37) | `jolan.boudin` | `android-mcp` tools + `adb` | app data, wiped by a clean install |

Account placement is deliberate and is itself a test axis:

- **W1 + A1 are the same user on two devices.** That is the MLS multi-device surface: history
  pooling ([WP-HIST-3](frontend/modules/chat.md#pooling-history-between-devices-designed-not-built)),
  cross-device read state, cross-device notification dismissal, device revocation.
- **W2 is the peer.** Every DM test is W1 <-> W2 (PC-PC) or W2 <-> A1 (PC-phone).

Credentials are **not in this repo**. They live in the session scratchpad,
`scratchpad/test-accounts.json`, written at setup time. Never commit them, never paste them into a
log excerpt, never echo a password into a shell that gets captured.

### 1.2 A fourth client, one day: iOS

Asked for on 2026-08-07: the same campaign, eventually, with **two PC sessions, one Android and one
iOS**. It is not scheduled - there is no iOS device available for a long while - but the shape is
worth fixing now, because it changes what "done" means for everything below.

- **iOS is the only platform where NOT ONE check has ever run on hardware.** Every iOS claim in this
  repo rests on compiling, and a green CI run does not even prove a given file compiled (the pbxproj
  is hand-maintained - see [cicd](cicd.md)). Treat every iOS row as unknown, not as passing.
- **Until then, parity is maintained by construction**, and the surfaces plus their guards are in
  [mobile > parity](frontend/mobile.md#android--ios-parity-and-where-it-is-actually-guaranteed).
  Every parity defect found so far has been in configuration, and two of them were found by checks
  on this page - so a check that fails on Android is worth re-reading as a question about iOS.
- **The harness generalises, the drivers do not.** `cdp.mjs` drives all three current clients because
  all three are Chromium; an iOS WKWebView speaks the WebKit remote-debug protocol instead, over
  `ios_webkit_debug_proxy`, and the native surfaces (`a1.py`, uiautomator2) have no iOS counterpart
  at all - the equivalent is XCUITest, which needs a Mac. Budget that as real work, not a flag.
- **A2 would be a THIRD client on jolan's account**, which is a test axis in itself: the multi-device
  paths (history pooling, cross-device read state, cross-device notification dismissal, revocation)
  have only ever been exercised with two devices, and several of them fan out per device.

### 1.1 The harness as BUILT (2026-08-05) - supersedes the plan above where they differ

The harness exists and is proven. It lives OUTSIDE the repo, at

```
C:\Users\jolan\AppData\Local\Temp\claude\c--Users-jolan-Documents-Programmation-canari\3dd9d8ba-077b-47ad-9f1d-33bb94f62dcd\scratchpad\
```

That path is session-named but the files persist on disk; a later session reuses them from there
rather than rebuilding. Contents:

| File | What |
| --- | --- |
| `cdp.mjs` | the CDP driver, both a CLI and an importable module (`connect`, `evaluate`, `until`, `realClick`, `activate`, `listTargets`, `SNAPSHOT`) |
| `login.mjs` | MiConnect/CAS login for one account, `--match` to pick a tab |
| `pin.mjs` | the encryption-PIN modal, both shapes, with `--stay` and `--value` for PIN-2/3/9 |
| `console.mjs` | run an action and dump console + failed requests - the web half of the evidence rule |
| `clip.mjs` | read the clipboard (the invite link is copied, never rendered) |
| `discover-web.mjs` | SETUP-7 web half |
| `admins.mjs` | which association is administered by whom |
| `a1.py` | uiautomator2 driver for the phone's NATIVE surfaces only (shade, permission dialogs, keys) |
| `chat.mjs` | the chat primitives every check shares: `client`, `openDM`, `openChannel`, `send`, `awaitMessage`, `countMessage`, `markers`, `bubbleCentre`, `hoverBubble`, `clickBubbleAction` |
| `watch.mjs` | **observation, attached to every check**: console, page exceptions, HTTP, WS, plus `logcatSince` for A1 and `sanity` for the pre-state |
| `results.mjs` | `record()` / `mark()`; every verdict is appended to `results.ndjson` |
| `msg1.mjs`, `msg2.mjs`, `msg3.mjs`, `msg5.mjs`, `losshunt.mjs`, `sendprobe.mjs` | the runners built so far |
| `test-accounts.json` | credentials - never in the repo |
| `a1-baseline/a1-clean-0.12.0.tar` | SETUP-8 rollback archive |
| `logs/a1.log` | the whitelisted logcat capture |
| `chrome-w1/`, `chrome-w2/` | the two persistent Chrome profiles |

**One driver, all three clients**, each on its own port:

| Client | Port | Launched with |
| --- | --- | --- |
| W1 (`jolan.boudin`) | 9224 | `chrome.exe --remote-debugging-port=9224 --user-data-dir=<scratchpad>/chrome-w1` |
| W2 (`claire.vanruymbeke`) | 9223 | same shape, `chrome-w2` |
| A1 (the Tauri WebView) | 9222 | `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` |

**W1 moved off the chrome-devtools MCP, deliberately.** Its own Chrome plus this driver is strictly
better here: a password never has to appear as a tool-call argument in a transcript, `login.mjs`
reads it from the credentials file instead. The MCP remains available as a second lens.

**Never `sleep` a fixed delay - poll.** `until(cx, predicate)` is the only wait primitive; fixed
sleeps were both slower than the app and unreliable when they were not.

Three things the login flow taught, which a naive script gets wrong:

- The hop is `canari-emse.fr` -> `auth.canari-emse.fr` (Authentik) -> `cas.emse.fr`. The middle step
  is a real render, so **poll for the `#username` FIELD, never for the CAS URL** - waiting on the
  hostname lands on the Authentik step and reads as a failure.
- The unlock modal is `#encryption-pin`, its button is `Déverrouiller`, and the lone checkbox is
  "rester connecté" - the vault path PIN-9 turns on.
- Svelte does NOT react to `input.value = x`. Text goes in through `Input.insertText` after a real
  click; clicks are `Input.dispatchMouseEvent` at the element centre, not `element.click()`.

The CDP domains that cover everything this campaign needs:

| Need | CDP |
| --- | --- |
| navigate, reload, close/open a tab | `Page.navigate`, `Page.reload`, `Target.*` |
| read the DOM / app state | `Runtime.evaluate` (returns JSON) |
| click, type | `Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent` |
| console + network evidence | `Log.entryAdded`, `Runtime.consoleAPICalled`, `Network.*` |
| storage corruption | `Runtime.evaluate` over `localStorage`/`sessionStorage`/`indexedDB` |

**Svelte does not react to `input.value = x`.** Set the value through the native setter and dispatch
a real `input` event, or use `Input.insertText` after focusing - a typed value that the framework
never sees is the classic false failure here.

The driver is a single reusable script, `scratchpad/w2.mjs`, exposing `nav`, `eval`, `click`,
`type`, `screenshot`, `console`. Build it ONCE, verify it against a login, then treat it as
infrastructure.

---

## 2. Phase 0 - setup (must fully pass before any test runs)

Nothing below is a test. It is the harness, and a harness that is not proven produces failures that
belong to itself.

| Id | Step | Done when |
| --- | --- | --- |
| SETUP-1 | Build the 0.12.0 debug APK: `bun tauri android build --target aarch64 --debug` in `frontend/`, then the jniLibs `.so` rescue (see [test_adb.py](../../test_adb.py) `_ensure_native_lib_present` - the Windows symlink failure builds an APK with no native lib) | APK exists under `gen/android/app/build/outputs/apk/arm64/debug/` |
| SETUP-2 | `adb uninstall fr.emse.canari` then a clean `adb install`. **This wipes `mls.bin`** - the device loses its MLS identity and its local history, by design | `dumpsys package` shows versionName 0.12.0, fresh `firstInstallTime` |
| SETUP-3 | Start logcat in the background with the 19-tag whitelist from [test_adb.py:415-435](../../test_adb.py#L415-L435). A tag missing there is a verdict that never arrives | log file growing in the scratchpad |
| SETUP-4 | W1: launch Chrome via MCP, log in `jolan.boudin`. **The one manual step: the 2FA code.** Then enrol the device and set PIN `1826` | conversation list renders |
| SETUP-5 | Build and verify `w2.mjs`; log in `claire.vanruymbeke` (**no 2FA on this account**); set PIN `1234` | W2 renders the conversation list, `eval` returns app state |
| SETUP-6 | A1: log in `jolan.boudin`, PIN `1826`. **Decline / disable biometrics** so PIN is always the unlock path - a fingerprint prompt is the one thing no tool here can answer | app reaches the conversation list; `canari_biometric_prompt_dismissed` set |
| SETUP-7 | **Discovery pass, do not skip.** Enumerate the real at-rest artefacts instead of guessing them: web = every `localStorage`/`sessionStorage` key + `indexedDB.databases()` on both browsers; Android = `run-as fr.emse.canari ls -lR files/ shared_prefs/ databases/`. Record the actual names in section 7 | section 7 filled with real names, sizes, paths |
| SETUP-8 | Baseline snapshot: copy the intact Android app data (`run-as ... tar`) to the scratchpad so every corruption test can be rolled back without a re-enrolment | archive exists |
| SETUP-9 | Create the **dedicated private channel** from W1, with `claire.vanruymbeke` as its only other member. Every channel check in this campaign uses it and nothing else | channel visible on W1, W2 and A1 |

SETUP-7 is what makes section 6 real. Corruption tests written against guessed key names test
nothing and pass silently.

---

## 3. Message tests

Baseline first. An exotic failure is only meaningful once the plain path is proven on the same
harness, in the same session.

| Id | Config | Action | Expected |
| --- | --- | --- | --- |
| MSG-1 | W1 -> W2, both foreground | DM, plain text | Arrives < 2 s, one copy, correct author |
| MSG-2 | W2 -> A1, app foreground | DM | Arrives in-app, no duplicate with the push |
| MSG-3 | W1 -> W2 | reply to a message | Reply renders with its quoted parent on both sides |
| MSG-4 | W1 -> W2 | image, then a PDF | Ciphertext upload, both render; check M (PDF preview) on A1 |
| MSG-5 | W1 -> channel | channel message with W2 and A1 as members | All three converge; no `Channel.masterSecret` in any payload (assert on the network response) |
| MSG-6 | W1 -> W2 | link that triggers a preview | Preview served through the proxy, never a third-party `<img src>` |
| MSG-7 | W2 -> W1 | 30 messages as fast as the driver allows | Order preserved on receipt, no gap, no duplicate |
| MSG-8 | A1 -> W2 | send from the phone while W2's tab is BACKGROUNDED (another tab focused) | Delivered; W2 badge/title updates |
| MSG-9 | W1 -> W2 | send while W2 is OFFLINE (`Network.emulateNetworkConditions` offline), then restore | Message lands on reconnect, once |
| MSG-10 | W1 | send while **W1 itself** is offline | Optimistic echo persists, outbox drains on reconnect, survives a reload before reconnect (`persistLocalMutation`) |

### 3.1 FWD - the open irreproducible bug

[WP-FWD-1](../../CLAUDE.md) is exactly the class of bug this campaign exists for: one forwarded
message was silently lost in prod, the toast said success, the outbox drained, the peer never got
it. Instrumentation shipped in `ca8e3ef0`; the decision was to wait for a recurrence. **This
campaign is the recurrence attempt.**

| Id | Config | Action |
| --- | --- | --- |
| FWD-1 | W1 channel -> W2 DM | forward, the exact shape of the prod loss |
| FWD-2 | same, x25 in a loop | any single miss is the bug |
| FWD-3 | forward while the sender goes offline mid-send | |
| FWD-4 | forward from A1 backgrounded immediately after (`input keyevent HOME` within 200 ms) | |
| FWD-5 | forward to a conversation the sender has never opened this session | |

Capture `[OUTBOX]` and `[QUEUE]` on **both** sides for every iteration, and keep the logs even when
they pass - a passing run is the control that makes a failing one readable. Reconcile by count:
messages sent vs messages received, asserted programmatically, not by eye.

---

## 4. Lifecycle tests

### 4.1 Web - tabs and windows (W1, W2)

| Id | State | Expected |
| --- | --- | --- |
| TAB-1 | Tab backgrounded (second tab focused), message arrives | Received; title/badge updates |
| TAB-2 | Tab closed, message arrives, tab reopened | Message present after reload, exactly once |
| TAB-3 | Whole browser closed, messages arrive, browser relaunched | All arrive; the persistent profile means no re-login - assert that too |
| TAB-4 | Two tabs of the SAME account open at once | No double-send, no double-decrypt, no epoch fight between tabs |
| TAB-5 | Reload mid-send (reload fired < 100 ms after submit) | Message either sent once or clearly queued - never lost, never doubled |
| TAB-6 | Session expiry: delete the refresh cookie, then act | 401 -> clean re-login, not a silent empty list |
| TAB-7 | Offline -> act -> online, tab never reloaded | Queue drains; `navigator.onLine` alone is not treated as proof of reachability |

### 4.2 Android - app states (A1)

| Id | State | How |
| --- | --- | --- |
| LIFE-1 | Foreground | baseline |
| LIFE-2 | Background | `input keyevent HOME` |
| LIFE-3 | Killed | Swipe from recents, NOT `am force-stop`: a force-stopped package is in Android's STOPPED state and the OS cancels every FCM broadcast to it until a manual launch (measured 2026-08-06, below). Force-stop is still worth running - it is what the settings screen does - but it answers a different question |
| LIFE-4 | Doze | `dumpsys deviceidle force-idle` |
| LIFE-5 | After reboot, app never opened | `adb reboot`, then send - exercises `CanariBootReceiver` |
| LIFE-6 | Offline | `svc wifi disable` + `svc data disable` |
| LIFE-7 | Notifications permission revoked mid-life | `pm revoke ... POST_NOTIFICATIONS` |
| LIFE-8 | Storage pressure / process death | `am kill` (not force-stop: simulates the OS reclaiming, keeping WorkManager state) |

Cross every LIFE state with: receive a DM, receive a channel message, receive a commit (member
added/removed), receive a call. That matrix is the point of the campaign - the bugs the user cannot
reproduce almost certainly live in one of its cells.

---

## 5. Notification tests

The known-hard cases first, because they are documented as hard and therefore falsifiable.

| Id | Scenario | Expected |
| --- | --- | --- |
| NOTIF-1 | App killed, DM arrives | Decrypted notification with real content |
| NOTIF-2 | App killed, **commit** pushed (add a member from W1), then a message | Background decrypt applies no commit -> generic fallback notification. **This is the epoch gap, not a bug.** Opening the app must recover and show the real message |
| NOTIF-3 | Same as NOTIF-2 but the message arrives several epochs later | Recovery still complete after foregrounding |
| NOTIF-4 | Read on W1 while A1 is killed | Notification dismissed on A1 (cross-device dismissal) |
| NOTIF-5 | Per-channel level set to muted on W1 | A1 does not notify; the message still arrives |
| NOTIF-6 | Notification action: quick reply from the shade | check K - reply delivered, appears on W1/W2 |
| NOTIF-7 | Notification tap -> deep link into the conversation, **run TWICE: app backgrounded, then app KILLED** | check H - correct conversation opens (`notifNav`, not a `/c/<id>` route) |
| NOTIF-8 | Doze + message | Delivered (high priority) or delivered on wake - record which |
| NOTIF-9 | Two devices of jolan (W1 open, A1 killed) | Exactly one notification surface behaves; no duplicate for the same message |
| NOTIF-10 | Airplane mode for 10 min, 5 messages sent, then reconnect | All 5 arrive; no collapse into one, or an explicitly correct summary |

NOTIF-2/3 double as the check that a **silent commit push** does not leave the next message
permanently unreadable.

**NOTIF-7 has a reported symptom and a suspect, from the user, 2026-08-06** - so it is not an open
question, it is a hypothesis to falsify. The deep link is believed to work with the app in the
BACKGROUND and to fail with the app KILLED. Backgrounded, the app is already past authentication and
`notifNav` publishes into a live router; killed, the tap starts a cold process that has to unlock
first, and the plausible failure is that the pending navigation is consumed - or dropped - while the
PIN / unlock screen owns the route. The two states are therefore two separate runs with two verdicts,
never one row. If the killed run fails, the thing to capture is whether the intent's payload ever
reached the web layer at all (a native-side loss) or reached it and was discarded by the unlock gate
(a routing loss): they are different bugs and the log distinguishes them. Deep-link plumbing and the
unlock paths are in [mobile](frontend/mobile.md) and [auth](frontend/modules/auth.md).

---

## 6. PIN tests

Read [auth](frontend/modules/auth.md) at execution time before touching this section - the PIN, the
device key vault and `mls.bin` are one mechanism, and this table must mirror what that page says,
not what a plan assumed a day earlier.

| Id | Scenario | Expected |
| --- | --- | --- |
| PIN-1 | Correct PIN unlock, online | Unlocks |
| PIN-2 | Wrong PIN x N | Rejected, no lockout that a correct PIN cannot clear, `mls.bin` untouched |
| PIN-3 | PIN < 4 chars at setup, change, recovery AND unlock | Same rule in all four - the documented lockout trap |
| PIN-4 | Change PIN on W1 | Device key re-wrapped; A1 and W2 unaffected; old PIN rejected everywhere it should be |
| PIN-5 | Change PIN on A1 while W1 is open | Same, from the native side |
| PIN-6 | Remove PIN (whatever the app offers: biometrics-only, stay-signed-in) | The at-rest key survives the transition; `mls.bin` still decrypts afterwards |
| PIN-7 | PIN unlock while OFFLINE | Per the durable rule, offline unlock is biometrics/vault only. Widening it to the PIN is a security change wearing a UX hat - so the expected result is a clean refusal, not a success |
| PIN-8 | Unlock while the server is unreachable but `navigator.onLine === true` (captive-portal shape: block the origin at the network layer, keep the interface up) | A transport failure must NOT log the user out. Only a 401/403 may |
| PIN-9 | "Stay signed in" on, browser closed, reopened | Vault path unlocks without a server round trip |
| PIN-10 | PIN correct but the vault blob is corrupt (see CORRUPT-3) | Explicit failure and a recovery path, never a silent wrong-key state |

---

## 7. Storage corruption

**Runs LAST.** It destroys state, and SETUP-8's archive is the only way back that does not cost a
full re-enrolment. Fill the real names here during SETUP-7 before writing any of these.

Discovered artefacts. **The web half is REAL, measured on both browsers 2026-08-05** by
`discover-web.mjs`; the Android half is still the documented expectation and must be replaced with
`run-as` output when SETUP-7 finishes.

`<dev>` below is the 64-hex device id, which differs per client: W1 (jolan) `d82cd226…4df2`,
W2 (claire) `b78568a3…d5ec`. **Every web artefact except three is keyed by it**, so a corruption
test that hardcodes one client's key silently no-ops on the other.

| Client | Artefact | Path / key | Notes |
| --- | --- | --- | --- |
| Web | MLS state | IndexedDB `CanariDBMls_<dev>` v1, store `state` | the browser's `mls.bin` equivalent |
| Web | message store | IndexedDB `CanariDB_<dev>` v6, stores `conversations`, `messages`, `outbox` | CORRUPT-7 drops a store here; the outbox store is what FWD-1 evidence lives in |
| Web | device key vault | `sessionStorage.canari_device_key_vault` (97 chars) + `canari_device_key_vault_key` (44) | AES-GCM wrapped; CORRUPT-3 targets the first |
| Web | vault persistence flag | `localStorage.canari_device_key_persist` | present on BOTH clients after a normal unlock |
| Web | device id | `localStorage.mls_device_id_<dev>` (82 chars) | |
| Web | last active | `localStorage.canari_last_active:<dev>` | |
| Web | saved user | `localStorage.canari_saved_user` (64) | |
| Web | WS auth | cookie `canari_ws_token` - the ONLY cookie readable from JS | the refresh cookie is HttpOnly, as designed |
| Android | MLS state | `mls.bin` (670 KB) - at the app data **ROOT**, NOT under `files/` | ChaCha20-Poly1305, `[nonce 12 \|\| ct]`, **no version field**: first bytes are the nonce, there is no magic to recognise |
| Android | message store | `canari_<dev>.db` + `.db-wal` + `.db-shm` | **WAL mode**, and the WAL is where the data actually is (1.4 MB of WAL against a 4 KB `.db`). Corrupting the `.db` alone tests NOTHING |
| Android | pending MLS | `mls_pending.db` | |
| Android | channel keys | `channel_keys.json` | |
| Android | push context | `push_context.json` | at the root too; see [mobile](frontend/mobile.md) |
| Android | device key | `shared_prefs/keystore_aliases.xml` - `<alias>_ct` and `<alias>_iv` | the Keystore-wrapped key; the Android twin of the web vault, and the CORRUPT-3 target on this side |
| Android | push secret | `pending_push_secret.txt`, `fcm_token.txt` | the FCM token is also mirrored in `shared_prefs/canari_prefs.xml` |
| Android | native flags | `native_flags.json` | `{"biometricPromptDismissed":true}` - this is what SETUP-6's refusal writes |
| Android | app log | `logs/Canari.log` | a second evidence source next to logcat |
| Android | WorkManager | `no_backup/androidx.work.workdb*` | outbox retry / background work state |

`run-as` reaches all of it **only because the installed build is debuggable**. The release build
that was on the device before refuses it outright.

Note what is NOT there: no access token in any web storage, on either client. That is the
"access tokens in memory ONLY" rule holding in production.

| Id | Corruption | Expected |
| --- | --- | --- |
| CORRUPT-1 | Truncate `mls.bin` to half its length | Explicit failure + recovery (re-enrol), never a silent empty history |
| CORRUPT-2 | Flip one byte inside the ciphertext (AEAD tag must fail) | Detected as tampering, not read as plaintext |
| CORRUPT-3 | Replace the web vault blob with valid base64 of garbage | PIN "accepted" then key rejected - the documented shape; must surface, not hang |
| CORRUPT-4 | Zero-length `mls.bin` | Treated as absent, clean re-enrolment |
| CORRUPT-5 | `mls.bin` from an OLDER envelope format (keep a copy from before any format change) | The durable rule says a reader for the previous format ships in the same commit - this test is what proves it |
| CORRUPT-6 | Delete `push_context.json` while the app is killed, then push | Either recovers on next launch or fails loudly; never a decrypt loop |
| CORRUPT-7 | Corrupt the web message store (drop an object store mid-session) | App recovers on reload; server history re-pulled |
| CORRUPT-8 | Wrong-user `mls.bin` (A1's file restored under a different account) | Rejected. **Security-relevant: a pass here that "works" is a finding.** |
| CORRUPT-9 | Fill the app's data dir until writes fail, then receive a message | No corruption of `mls.bin` from a half-written save (lost-update -> `SecretReuse`) |
| CORRUPT-10 | Kill the process **during** an `mls.bin` write (send a burst, `am kill` mid-write) | Next launch either reads the old state or re-enrols; never a half-file read as valid |

CORRUPT-8 and CORRUPT-10 are the two that would be security findings rather than bugs.

### 7.1 HEAL - does a BROKEN GROUP repair itself on the BROWSER? (added 2026-08-06)

Everything WP-PENDING-2 and WP-DRAIN-1 proved was proved **on the phone**. The fixes are shared
TypeScript, so the browser runs the same classifier, the same `startRecovery` and the same
generation-gap branch - but "the same code" is an argument, not a measurement, and the two clients
do not break the same way: the web MLS state is IndexedDB rather than `mls.bin`, the recovery runs
against a live WebSocket instead of a cold reconnect, and only the browser has a second tab that can
be holding the leader role while the broken one recovers.

**Gated on the web deploy.** A long-lived tab keeps its old bundle, so both browsers must be
RELOADED after the CD lands before any of these is measured - the same trap that failed the first
TAB-4 re-run.

The break is made by RESTORING an older snapshot of `CanariDBMls_<dev>` (store `state`) over the
current one, which is exactly the rewind the campaign has been chasing, done deliberately. Take the
snapshot first; without it there is nothing to restore and the only way back is a re-enrolment.

| Id | How the group is broken | Expected |
| --- | --- | --- |
| HEAL-W1 | Restore a snapshot from BEFORE a membership commit, then have the peer send | Epoch gap: the commit replay applies >0 commits and the message renders, once. A `healed` verdict after applying ZERO commits is the WP-PENDING-2 fault reappearing on the web |
| HEAL-W2 | Restore a snapshot from BEFORE the group was joined at all, then have the peer send | Unknown-group path: welcome request or external join, and **`[QUEUE] Drain start` is followed by `Drain complete`** - the drain must never be held by the recovery (WP-DRAIN-1's shape) |
| HEAL-W3 | Freeze W1 on a snapshot while the peer advances its sender ratchet past 2 000 frames in one epoch (read receipts count, which is how the phone got there) | Generation gap: `LOST frame`, `forgetGroup`, `requestReAdd`, then fresh messages arrive once each. The `TooDistantInTheFuture` classifier must beat `GAP_QUEUED`, as it does on Android |
| HEAL-W4 | HEAL-W2 with a SECOND tab of the same account open and holding the leader role | The recovering tab must not encrypt, and the leader must not be dragged into the follower's repair - the WP-MULTITAB-1 seam meeting the recovery seam, which nothing has ever exercised together |

HEAL-W4 is the one with no prior art on either client. HEAL-W3 is the expensive one: 2 000 frames is
a scripted volume run, not a manual one.

#### Result, 2026-08-10: the diff repairs it, and a SHALLOW break never reaches the diff

Run with `heal-web.mjs`, which breaks the group the way the campaign has been chasing - restore an
older copy of W1's MLS state (one 2.93 MB `mls_autosave` blob in `CanariDBMls_<dev>`), reload W1 so
the WASM client picks the rewound state up, then keep sending. The rewind DEPTH is simply how many
messages W1 sent between the snapshot and the restore, and it turned out to be the variable that
decides everything:

| Rewind depth | Loss window | Signals | Escalated? | Outcome |
| --- | --- | --- | --- | --- |
| 12 generations | ~60 s | 2 | **no** | **5 messages lost permanently**, W1 14/14 vs W2 9/14 |
| 60 generations | ~150 s | 3 | yes | **healed 16/16** |

Both runs show the break itself exactly as designed: `Ciphertext generation out of bounds 2445`,
`SecretReuseError`, then `[MLS] LOST frame … the sender's ratchet rewound`.

**The narrow retransmission never delivered anything, in either run.** It fired with 1, then 5, 15
and 25 payloads - growing, because `recentSentSince` re-sends everything in the last 120 s - and not
one of those payloads arrived, for a reason that is structural rather than incidental:
`signalDecryptFailure` has exactly ONE call site, the rewound-sender branch, so the peer it asks is
by construction the peer whose ratchet is rewound, and the retransmission is encrypted at that same
rewound ratchet. It collides exactly as the original did.

What it does do is consume generations, and that is what ended the shallow run: 5 real sends plus 7
retransmitted payloads is 12, precisely the rewind depth. **The conversation recovered by burning
through the overlap, not by repairing anything**, and the five messages caught inside the overlap
are gone - the sender shows them, the receiver never had them, and nothing tells either user.

The deep run is the one that reaches the mechanism WP-HIST-3 built, and it works:

```
[HISTORY_DIGEST] From b78568a3… for 642f389a… - ids, 357 id(s)
[HISTORY_BUNDLE] Chunk 1/1 - 32 msg → 642f389a…
[HISTORY_REQ] 642f389a... diff with b78568a3…: 32 to send, 1 to pull
```

`ids` mode and a bounded diff, not `no digest … sending the whole store` - so the 3 s
`HISTORY_DIGEST_GRACE_MS` rendezvous was won and the run measured the new mechanism rather than the
old dump wearing its name. Three diffs, 30 s apart, driven by the durable marker's own pending
timer (`[HISTORY_REQ] restarted pending timer`, `solicit attempt 2`), and full convergence.

So the escalation ladder had it backwards: it gated the repair that works behind three failures of
the repair that cannot work. Three signals rate-limited to one per 30 s need 60-90 s of CONTINUOUS
loss, and a shallow rewind clears itself first - partly by burning generations on those very
retransmissions. Fixed by soliciting the diff on the FIRST detection, alongside the narrow signal
instead of after it; the narrow one is kept because it costs one control frame and does win the
band where the sender has already burnt past the receiver's high-water mark, but nothing waits on
it now. See `inboundFrameLedger.ts`.

**The lesson generalises past this bug:** a repair ladder must be ordered by what each rung can
actually FIX, never by what each costs. Cheap-first is only sound when the cheap rung has a real
chance, and here its single trigger guaranteed it did not.

---

## 8. Multi-device (W1 + A1, same user)

| Id | Scenario | Expected |
| --- | --- | --- |
| MULTI-1 | Send from W1 | Appears on A1 as own message, not as an incoming one |
| MULTI-2 | Read on A1 | Read state reflected on W1 (known backlog item - record actual behaviour) |
| MULTI-3 | A1 enrolled AFTER W1 has history | History pooling is currently all-or-nothing ([WP-HIST-3](frontend/modules/chat.md#pooling-history-between-devices-designed-not-built)) - record exactly what arrives |
| MULTI-4 | Revoke A1 from W1, then A1 acts | check L - clean re-enrolment, no half-state |
| MULTI-5 | Same user, W1 + A1 + a second W1 tab, one channel | No epoch conflict, no `SecretReuse` |
| MULTI-6 | A1 offline for a long window, W1 sends 20 messages, A1 returns | All 20, ordered, once |

---

## 9. Evidence and reporting

**Observation is part of the check, not a debugging step** (decided 2026-08-06). A check that only
asserts its own outcome answers "did the message arrive", never "did it arrive for the right
reasons" - and a pass sitting on a swallowed exception, an unread 4xx, a request that should not
have been made or a reconnect mid-measurement is worth nothing. WP-LOSS-1 is exactly a green-looking
path with a dropped message underneath it.

So `watch.mjs` attaches to every client for the duration of every check and sorts what it saw into
five buckets, reported next to the verdict:

| Bucket | Meaning |
| --- | --- |
| `errors` / `exceptions` / `badHttp` / `wsEvents` | anything here makes the run **not clean**, whatever the assertion said |
| `notable` | not an error, but it happened: `SecretReuse`, `out of bounds`, `Duplicate`, `silent ACK`, `epoch`, `GAP`, `out-of-sync`, `welcome_request`, `forget`, `revoke` |
| `stateChanges` | the client changed under the check's feet - gateway reconnect, token refresh, session change. Explains a latency or a retry that would otherwise look like a result |
| `unexplained` | everything not on the known-benign list, **verbatim**. The point is to see what was not predicted; when a line turns out to be routine it is added to `BENIGN`, never ignored in place |

A verdict is `PASS` only when the assertions hold **and** the run is clean; otherwise
`PASS-WITH-NOISE`, which is a result that still needs reading. On A1, `logcatSince()` pulls the same
19-tag whitelist as `test_adb.py` for the same window - `-T "MM-DD hh:mm:ss.mmm"` in the DEVICE's
local time, not ISO and not UTC.

For every check, capture **before deciding**:

- Android: the logcat window around the action, filtered to the 19 tags.
- Web: `list_console_messages` (W1) / buffered console (W2), plus the relevant network request.
- A programmatic reconciliation where counting is possible (sent vs received), never a visual judgement.

Then:

- **PASS** -> one row in the results table, with the log line that proves it.
- **FAIL** -> a Work Package in `CLAUDE.md`, severity per its rules, **with the captured log inline**.
  A durable marker written without its evidence is legacy - the durable rule on that is explicit.

The campaign is not "done" when the tables are full. It is done when every FAIL is either a WP or a
fixed commit, and the results table says which build produced it (`versionName` + git SHA).

### 9.1 Reading a repair on the wire

The remaining phases (HEAL, MULTI, CORRUPT) all measure the repair mechanism, and **it is invisible
to the network panel**: the diff travels as encrypted MLS application frames, so the server sees one
HTTP call and nothing else. The whole negotiation is only observable in the CONSOLE. The design
itself is in [chat > pooling history between devices](frontend/modules/chat.md); this is the map
from that design to what a run can actually grep. Established 2026-08-07 so the next session does not
re-derive it.

**The only server-visible seam** is `POST /api/mls/history-request`
(`messaging.controller.ts`), which elects one online member and relays. Server logs
`[HISTORY_REQ][<trace>] FORWARDED target=… ` or `NO_PEER_ONLINE`. Everything after that is MLS.

| Console prefix | Emitted by | What it tells a check |
| --- | --- | --- |
| `[HISTORY_REQ]` | requester + responder | the whole negotiation, both ends |
| `[HISTORY_DIGEST]` | requester broadcast, responder receipt | leg 2 arrived, and in which mode |
| `[HISTORY_PULL]` | responder -> requester | the REVERSE direction (the requester holds more) |
| `[HISTORY_BUNDLE]` | responder | what was actually shipped, filtered by id |
| `[MLS]` | `setupMessageHandler` | the escalation from the narrow repair into the diff |

The four lines that decide a HEAL verdict, and each says something different:

- `[HISTORY_REQ] …: N to send, M to pull (identical stores)` - the diff RAN. This is the success line.
- `[HISTORY_REQ] no digest from <identity> … - sending the whole store` - **the fallback fired.** The
  run is not a failure, but it did not test what it meant to: the 3 s `HISTORY_DIGEST_GRACE_MS`
  rendezvous lost, so this is the old full dump wearing the new mechanism's name. Re-run it.
- `[HISTORY_REQ] … store unreadable - staying silent so another member answers` and `… nothing to add
  and we are awaiting history too - staying silent` - a deliberate silence. **A responder that stays
  silent looks exactly like a responder that never got the request**, so a check asserting "no repair
  happened" must read the responder's console too, not only the requester's.
- `[MLS] Retransmission has not repaired <short>… - escalating to a history diff` - the seam between
  the two mechanisms.

**The narrow `decrypt_failed` retransmission still exists** - WP-HIST-3 demoted it to the first-line
repair rather than deleting it (window `DESYNC_RETRANSMIT_WINDOW_MS` 120 s, cap 5 min). So a repair
seen on the wire may be EITHER mechanism, and a check that does not distinguish them cannot claim to
have exercised the diff. That distinction is the one thing every HEAL check must assert.

---

## 10. Results

_Filled during execution. One row per check: id, build, verdict, evidence pointer._

Raw rows are appended to `scratchpad/results.ndjson` as each runner finishes; captures land in
`scratchpad/logs/`. The table below is the readable summary.

| Id | Build | Verdict | Evidence |
| --- | --- | --- | --- |
| MSG-1 | web, prod 2026-08-06 | **PASS** | DM W1 -> W2, delivered in 1225 ms, one copy each side, author `Jolan BOUDIN`. Re-proved by 38 consecutive sends below. |
| MSG-1 (volume) | web, prod 2026-08-06 | **PASS** | 20 sends at 1.2 s spacing: 20/20, latency 177-830 ms. 8 sends each preceded by a receiver reload: 8/8, 493-1191 ms. 10 sends into the receiver's post-reload bootstrap window: 10/10, 505-1170 ms. |
| MSG-2 | A1 0.12.0, prod 2026-08-06 | **PASS** | W2 -> A1 with the app foreground: 2665 ms, one copy, no push duplicate. |
| MSG-3 | web, prod 2026-08-06 | **PASS** | Reply renders with its quoted parent on BOTH sides, 509 ms. Composer showed `Répondre à Jolan BOUDIN parent MSG3P-…`. |
| MSG-5 | all three, prod 2026-08-06 | **PASS** | Channel message converged 1/1/1 (W2 741 ms, A1 117 ms). **Zero** `masterSecret`/`webhookSecret` in any `/api/` response body on any client. No errors, no 4xx, nothing unexplained on any of the three. |
| MSG-4 | web, prod 2026-08-06 | **PASS** | Image 1476 ms, PDF 1113 ms, one copy each, caption present. Receiver decoded the picture (`<img src="blob:">`, `naturalWidth` 64x64) - not merely a bubble. |
| Check M | A1 0.13.0, prod 2026-08-06 | **PASS** | PDF first page rendered on hardware: two `<img alt="Aperçu de la première page du document">` at `naturalWidth` 116x116 from `blob:`, plus a full-screen affordance. Logcat clean. |
| MSG-6 | web, prod 2026-08-06 | **PASS** | Preview rendered on the receiver with **zero** third-party `<img src>` - every image same-origin, blob or data URI. Its observation log also carried a `400` on `/api/mls/link-preview`, which turned out to be a shipped bug: see below. |
| MSG-7 | web, prod 2026-08-06 | **PASS** | 30 rapid sends W2 -> W1: 30/30 received, order preserved, no duplicate, 12.7 s. Clean on both sides - notably **no** `SecretReuseError`, so a burst alone does not provoke the WP-LOSS-1 branch. |
| FWD-1 | web, prod 2026-08-06 | **PASS** | Channel -> DM forward delivered in 371 ms, one copy. |
| FWD-2 | web, prod 2026-08-06 | **FAIL -> WP-FWD-1 REPRODUCED** | Three consecutive forwards lost, then 8/8 delivered on a re-run. Sender kept its echo, receiver never had them, the DM was healthy both ways at that moment. See below. |
| **Reconciliation** | web, prod 2026-08-06 | **method, plus 5 losses** | 54 markers on W1 vs 53 on W2 over a bounded common window: 3 forwards missing from the receiver, 2 sent messages missing from the SENDER. Two different defects. See below. |
| **Silent loss** | web, prod 2026-08-06 | **FAIL -> WP-LOSS-1** | Two DMs accepted by the server (`POST /api/mls/send -> 201`), never rendered by the peer, still absent after a reload. See below. |
| MSG-8 | A1 0.13.0 -> web, prod 2026-08-06 | ~~PASS~~ **-> WRONG VERDICT, see WP-HIDDEN-1** | Sent from the phone while W2's tab was hidden: decrypted while hidden, rendered exactly once on return. The verdict was PASS and the explanation written here - "a hidden tab gets no frames, so that is the browser, not the app" - was **wrong**. Nothing appeared because the drain had HUNG, and the check only ever looked after restoring the tab, which is exactly what released it. One message hides the bug; two expose it. |
| MSG-8b | A1 0.13.0 -> web, prod 2026-08-06 | **PASS, with a UX note** | W2 on another page and hidden: badge `1 non lus` and `Discussions | 1` on refocus, message present once. **The tab title never changes**, so a backgrounded tab signals nothing until it is looked at - `useNotifications` does blink the title, but only for its own notification path. W2 also logged a `SecretReuseError` on a message it nonetheless rendered: the duplicate branch fires legitimately too, which is exactly why WP-LOSS-1 cannot classify on it alone. |
| FWD-3 | web, prod 2026-08-06 | **FAIL -> same root cause** | Sender cut right after the picker closed: `POST -> 201` had already gone, receiver never rendered it, `SecretReuseError` on the receiver. Not an outbox failure - the same rewind. |
| FWD-4 | A1 0.13.0 -> web, prod 2026-08-06 | **PASS** | Sent from the phone and HOME pressed 200 ms later: delivered, one copy, sender kept its echo. Leaving the foreground mid-send costs nothing. |
| FWD-5 | web, prod 2026-08-06 | **FAIL -> ROOT CAUSE FOUND** | Forward into a conversation not opened this session: **4/4 lost**, every one `POST -> 201` then `out of bounds 110` + silent ACK on the receiver. The `Page.reload` is the cause, not the forward. See below. |
| **Reload rewind** | web, prod 2026-08-06 | **FAIL -> WP-LOSS-1, deterministic** | Reload 300 ms after a send loses the next message (twice, generations 118 and 120); reload 20 s after it delivers in 694 ms. Deferred MLS disk writes let a reload restore a ratchet behind the one already used. See below. |
| MSG-9 | W1 -> A1 0.13.0, prod 2026-08-06 | **PASS** | Phone's radios cut (`svc wifi disable` + `svc data disable`), `navigator.onLine` false in 516 ms. Nothing arrived while down; **one** copy after the radios came back, 26.3 s later. The delay is the app's own keepalive: `[WS] 4 pings without server response - closing zombie connection`, then `Reconnecting...` and `[PENDING] Fetched 3 pending messages`. |
| MSG-10 | web, prod 2026-08-06 | **PASS** | Sender cut mid-session: composer emptied, the sender rendered its own message immediately, the peer had nothing, `[OUTBOX] Flush skipped - offline; the queue is kept intact`. On reconnect it drained in 1011 ms, one copy each side - **and it survived a reload of the sender**, which is the `persistLocalMutation` predicate WP-ECHO-1 turns on. So the offline path persists correctly; whatever loses the sender's echo is a different route. |
| TAB-5 | web, prod 2026-08-06 | **PASS** | Reload fired 30-40 ms after submitting: 7 rounds, exactly one copy on the sender and on the receiver every time. The message is queued in the outbox before the reload and `[OUTBOX] Flushing 1 queued entry` delivers it after - so the outbox survives a reload. Two early rounds carried `out of bounds` + silent ACK on both sides with no loss; not reproduced in 4 further rounds, and never accompanied by a missing message. |
| TAB-4 | web, prod 2026-08-06 | **FAIL -> WP-HIDDEN-1** | Two tabs of one account: the peer's message reached NEITHER, and a send from the first tab reached nobody. Not a leader-election bug - opening a second tab merely HIDES the first, and a hidden tab stops draining. See below. |
| **Hidden tab** | web, prod 2026-08-06 | **FAIL -> WP-HIDDEN-1, deterministic** | One tab, backgrounded: message #1 decrypts and never renders, #2 is enqueued and never drained, and both appear at the exact millisecond the tab is refocused (13:10:53 -> 13:11:19). `yieldToMainThread` awaited `requestAnimationFrame`, which never fires in a hidden document. See below. |
| **Reload rewind, re-run** | web, prod 2026-08-06 | **PASS - fix verified** | Same reproduction against the deployed `a8cc7027`: **3/3 delivered** after a 300 ms reload, 700 / 681 / 772 ms, receiver log clean. That matches the 694 ms no-reload control, where the pre-fix build lost 2/2. Sender half closed; the receiver half of WP-LOSS-1 stays open. |
| **Two tabs, re-run** | web, prod 2026-08-06 | **PASS - fix verified** | Same script that lost 4 of 9 alternating sends: **9/9 delivered**, 360-1035 ms, nothing notable on the peer. No `out of bounds`, no `SecretReuseError`, no silent ACK. |
| **Two tabs, mechanism** | web, prod 2026-08-06 | **PASS** | Nine green sends do not prove the follower stopped encrypting - it may simply not have been behind. So the two tabs' own logs were read while the FOLLOWER sent: follower `Queued 3eded7b2… (text)` then `Flush skipped - follower tab; asking the leader to drain the shared queue`, and one second later the LEADER logs `Flush requested by a follower tab` / `Flushing 1 queued entry` / `3eded7b2… sent in 642f389a…`. Same entry id on both sides, which is also the proof that the shared IndexedDB queue is the transfer and the channel only carries the instruction. The follower logged no send of its own; the peer had exactly one copy. |
| TAB-2 | web, prod 2026-08-06 | **PASS** | App tab closed (proven gone from `/json/list`), peer sends, tab reopened: the message is there **exactly once**, both logs clean. The reopened tab did **not** ask for the PIN - the unlock survives within the same browser instance, which is the vault path, not a gap. |
| TAB-3 | web, prod 2026-08-06 | **PASS** | Browser killed (port dead in 6 ms), two messages sent while down, relaunched in 611 ms: **no re-login** - the persistent profile carried the session and only the PIN was asked - and both messages present exactly once. |
| TAB-3 (cold-start timing) | web, prod 2026-08-06 | **PASS, with one unexplained run** | Five timed cold starts: PIN entered at ~3.5 s, message rendered at **4.9 / 5.6 / 5.6 / 5.1 s**. One earlier run took **77.7 s** with everything ready at 6.9 s (`Leadership acquired` 5.9 s, WS open 5.9 s, `[PENDING] Fetched` and `Drain start` 6.9 s) and `[MLS] Message decrypted` only at 77.7 s - a 71 s gap between a drain starting and a message coming out of it. Not reproduced in four further runs. Not a WP without a reproduction; if it recurs, capture everything between `Drain start` and the decrypt. |
| TAB-6 | web, prod 2026-08-06 | **PASS** | `canari_refresh` deleted, then a reload: the app lands on `/login` with "Se connecter", **not** on a logged-in-looking empty list. Log clean. Note the IdP session survives (`authentik_session`, CAS `TGC`), so signing back in needed no credentials - one click and the app was back. |
| **WP-KBD-1** | A1 0.13.0, prod 2026-08-06 | **FAIL -> WP-KBD-1** | Tap the composer, HOME, return: the shell is pinned to the visual viewport but starts below the status-bar inset, so it overflows by that inset and the composer sits behind the keyboard. Numbers in [mobile](frontend/mobile.md#the-soft-keyboard-and-the-app-shell-wp-kbd-1-open). |
| LIFE-1 (smoke, post-flash) | A1 rebuilt 2026-08-06, prod | **PASS** | First run of the build carrying BOTH P1 fixes and the Rust `SecretReuse` change: 3/3 DMs from W2, 835 / 796 / 654 ms, one copy each, no error. The Rust half is proven present in the APK by `already-consumed generation` in `libmines_app_lib.so`; the TS half by the four fix strings in the bundled `frontend/build`. One notable line, unexplained: `[KP] Publication failed (register-device) - welcome_request deferred to next connection`, a transport error 7 s after unlock, while `needed=0`. |
| LIFE-2 | A1 rebuilt 2026-08-06, prod | **PASS** | HOME pressed, then a DM: notification in **4.8 s** carrying the real decrypted text (`Claire VAN RUYMBEKE` / the marker), so the background decrypt works. On return the message was **already there** - present 20 ms after the app came back, exactly once, no PIN re-ask. |
| LIFE-3 | A1 rebuilt 2026-08-06, prod | **FAIL - but read both halves** | `am force-stop`, then a DM: **no notification**, and after the relaunch the message never arrived at all. The first half is Android, not Canari: logcat shows `GCM broadcast intent callback: result=CANCELLED for act=com.google.android.c2dm.intent.RECEIVE pkg=fr.emse.canari` - a force-stopped package is in the STOPPED state and the OS withholds every broadcast until a manual launch. The second half is ours, and it is a new WP: see below. |
| **DM names** | web + A1, prod 2026-08-06 | **FAIL -> FIXED, VERIFIED ON PROD** | Every DM row read "Utilisateur inconnu" after a client-side navigation into `/chat`, on both platforms; a full load resolved them. Re-proved on A1 0.13.0 from a COLD start: `unknown = 0` at 3 s, 6 s and 10 s, six real names. See below. |

### Reconciliation: the only way this class of loss can be seen

A silent loss leaves no mark anywhere a single client can look. The sender keeps its optimistic
echo, the server answered `201`, and the receiver simply never had the row - so both UIs are
self-consistent and both are wrong about the conversation. The only evidence is a SET DIFFERENCE
between the two clients' view of one thread, which is why every campaign message carries a unique
`PREFIX-<base36>` marker: DOM rows have no id, but the text does.

**Getting the measurement right took two corrections, and the first version of this section stated a
conclusion that was wrong.** Both faults are recorded because either one silently produces an
authoritative-looking diff made of noise:

- **The list is VIRTUALISED.** `innerText` holds only the rows currently rendered, so scrolling to
  the top and reading once returns the oldest screenful and drops everything in between. The first
  run did exactly that and reported "W2 is missing `MSG1-msh23b0gp99` and `PROBE-msh25j5eovk`" -
  from which this page concluded the WP-LOSS-1 losses were permanent. **They are not: W2 has both.**
  `collect()` now reads at every scroll position and accumulates.
- **The two windows do not coincide, and deriving the bound from the data does not fix it.** Each
  side loads whatever its scrolling reached, so a marker absent from one list may simply be older
  than that side went. Bounding the diff to "the newer of the two oldest markers" still makes the
  answer depend on how far each run happened to get: **two consecutive runs disagreed**, one calling
  a dozen messages lost that the other reconciled. The window is therefore FIXED (90 minutes by
  default, `RECON_WINDOW_MIN`), and each side must hold at least one marker OLDER than it - that is
  the only evidence it covered the range. The run reports `covered` and `trustworthy`; a diff
  without both is not a result.

Markers carry their own send time (`mark()` = prefix + base36 `Date.now()` + 3 random chars), which
is what makes any of this possible.

Run 2026-08-06 11:0x with both corrections, over a window starting 07:07 local:

| | W1 | W2 |
| --- | --- | --- |
| markers collected | 54 | 53 |
| reached | top in 10 steps | top in 7 steps |

- `onlyW1` = `FWD-msha08bvsf4`, `FWD-msha18ihdnk`, `FWD-msha28vvm29` - **three forwards the receiver
  never got**, 10:50-10:52.
- `onlyW2` = `HUNT06-msh29yxqslj`, `HUNT07-msh2a06i3bj` - two messages **W1 sent and no longer has**.

These are two different defects and must not be merged. The `FWD` three are the WP-FWD-1 shape:
sender keeps its echo, receiver has nothing. The `HUNT` two are the opposite - the receiver has
them, the SENDER lost its own copy - which is the failure mode the durable rule about
`persistLocalMutation` predicts, since MLS gives no echo of your own message and `losshunt.mjs`
reloads clients. `openChannel` reloads W1 on every iteration, so W1 had ample opportunity.

It also settles a scare from the MSG-4 run, where the receiver logged four
`Ciphertext generation out of bounds … SecretReuseError` (generations 49, 50, 52, 53) while the
check still passed. Those cost no message: they are the replay path re-encountering frames that
WERE already delivered, which is the benign half of the very branch WP-LOSS-1 indicts. That is the
point of the fix being a reconciliation against the local store rather than a change of
classification - the same error legitimately means "already have it" most of the time.

### The bug found in a PASSING check's log

MSG-6 passed: the preview rendered and no third party was contacted. Its observation carried one
line that had nothing to do with the assertion -

```
GET /api/mls/link-preview?url=https%3A%2F%2Ffr.wikipedia.org%2Fwiki%2FSignal_(application -> 400
```

The URL is cut before its closing parenthesis. `HTTP_URL_RE` excluded `)`, `]` and `}` from the
match, which is the obvious way to stop `see (https://x.com)` from swallowing its wrapper - and it
truncates every URL that legitimately contains one. The **rendered `<a href>` was truncated too**,
so the link a reader clicks leads to a page that does not exist; the 400 was only the visible half.
Fixed by deciding on balance rather than by exclusion, with a second defect found next to it (the
splitter resumed after the raw match, deleting whatever the trimmer shed from the message text).

Worth generalising: the check that found it was **green**, and a run reported as `PASS-DIRTY` with
one 4xx was the only signal. Section 9 exists for this.

### FWD-1 / FWD-2: the forward loss REPRODUCED, three times

WP-FWD-1 had never been reproduced. It now has been, and the profile is sharp enough to act on.

| Run | Result |
| --- | --- |
| FWD-1, single | delivered, 371 ms |
| FWD-2, first iterations | **3 lost in a row** (10:50:47, 10:51:xx, 10:52:xx) |
| `fwdprobe`, single, right after | delivered, 475 ms, `POST /api/mls/send -> 201` |
| FWD-2 re-run, 8 iterations | **8/8 delivered**, 432-509 ms |

What the losses are NOT: the forwards reached the intended conversation. `fwd-triage.mjs` searched
the channel, the DM on both clients and every other DM W1 can open - both markers were in
**`W1/dm:Claire VAN RUYMBEKE`** and nowhere on W2. The picker was also confirmed to resolve inside
`[role=dialog]` to the row reading exactly `Claire VAN RUYMBEKE`.

And it is not a dead conversation: `dmprobe.mjs` sent a plain composer message each way immediately
afterwards - **W1 -> W2 in 1249 ms, W2 -> W1 in 653 ms, one copy, nothing notable on either side**.
So the DM was healthy while forwards into it were being lost.

**The load hypothesis was tested, and it does not hold.** The three losses fell inside the window
where the machine was running the pre-commit sweep and a `git push`, and nothing before or after
that window was lost - so the obvious guess was CPU starvation. Re-running `bun run check` and
`bun run lint` in a loop for the whole duration of a **12-iteration** forward batch produced
**12/12 delivered**, 326-528 ms. The correlation is coincidence, and the only lead this bug had
offered is closed.

Standing tally for the day: **25 forwards, 3 lost, all three inside one two-minute window, 21
consecutive successes since.** A final reconciliation over the last 90 minutes (deterministic,
`trustworthy: true`, run twice) shows W1 with 30 markers and W2 with 27, the difference being
**exactly those three** and nothing else.

**Still owed on it:** the per-iteration capture of `POST /api/mls/send` was added AFTER the three
losses, so it is not yet known whether a lost forward reaches the network at all. That single fact
splits the diagnosis in two - no request means the client dropped it (the outbox swallowing a
branch), a `201` means the receiver discarded it (WP-LOSS-1). `fwd.mjs` now records it per
iteration; the next reproduction answers it.

### The bug that only a click could find

Noticed while opening the phone's Discussions tab for MSG-2, and worth recording as a method as much
as a defect: **it is invisible to anyone who reloads.** A full load of `/chat` shows every name; a
click on "Discussions" from inside the app leaves all six DMs reading "Utilisateur inconnu"
indefinitely - measured to 2.5 minutes, and it does not heal.

The sequence that isolated it, each step cheap and each one killing a hypothesis:

| Step | Result | What it eliminated |
| --- | --- | --- |
| Same click-navigation on W1 | 6 unknown | not Android - the first suspicion, since it was seen on the phone first |
| Count `/api/users/<id>` calls in both modes | 6 vs 7, all `200` | not a missing fetch |
| Read the response BODIES | `"firstName":"Claire","lastName":"VAN RUYMBEKE"` in the failing mode | not a server answer - the name arrives and is discarded |
| Wait out the 2-min `FAILURE_BACKOFF_MS` | still 6 unknown | not `failedAt` / the retry backoff |
| Full load, then navigate away and back by click | 0 unknown | the display-name **cache being warm** is the whole variable |

Cause, fix and the general rule are in the `CHANGELOG` entry and in DURABLE RULES. The reusable
lesson for this campaign is the second row: **reproduce a platform-specific symptom on the other
platform before believing it is platform-specific.** It cost one command and turned an Android bug
into a shared one.

**Verified on production after the CD (2026-08-06)**, by re-running the exact reproduction rather
than trusting a green deploy:

- hard reload of `/communities`, then a **click** on Discussions: `unknown = 0` at 3 s, 6 s and 10 s
  (it was 6, permanently, before);
- the forward picker lists all six people by name (five were anonymous), and typing `Arthur` in its
  search box filters to `Arthur PIZOT` - the action that was impossible, since the filter matches on
  the same label.

### The loss this campaign was built to find

**Found on the first real check, in the plainest configuration there is**: a DM, both clients
foreground, both online, no forwarding involved. Two of the first four messages in a freshly created
DM were lost. The sender shows them; the receiver has never shown them and no longer can.

The capture (`scratchpad/logs/sendprobe-PROBE-msh25j5eovk.json`) closes the question WP-FWD-1 left
open, which was whether the sender ever posted:

| Stage | What the capture shows |
| --- | --- |
| Sender | `POST /api/mls/send -> 201`. The server accepted it. |
| Transport | The receiver **received the frame**: `[WS RCV] JSON frame: senderId=d82cd226…, isWelcome=false, protoLen=320`. |
| Receiver decrypt | `[RUST::DEBUG] Ciphertext generation out of bounds 1 / SecretReuseError` |
| Receiver policy | `[MLS] Duplicate for 642f389a… - silent ACK`, then `[QUEUE] messageCallback -> true` |

So the message is not lost in transit at all. It is **delivered, then discarded by the client**,
because `SecretReuseError` is classified as a benign duplicate:

- live path - [`setupMessageHandler.ts`](../../frontend/src/lib/mls-client/messagePipeline/setupMessageHandler.ts)
  `if (kind === 'secret-reuse') { log(...); return true; }`
- replay path - [`history.ts`](../../frontend/src/lib/utils/chat/history.ts) adds the fingerprint to
  `seenCipherHashes`, so the one mechanism that could have recovered it makes the loss permanent.

**Neither path checks whether the message was ever actually delivered.** That is the defect, and it
is independent of whatever causes the ratchet desync: the client knows the frame's fingerprint and
knows its own message store, so "the secret for this generation is already consumed" and "the user
has already seen this message" are two different facts. When they disagree, the truth is a desync,
not a duplicate - and the existing `unknown` branch already has the right response (`onOutOfSync`).

Not reproducible on demand: **38 subsequent sends were delivered, 38/38**, including 18 that
deliberately targeted the receiver's reload and bootstrap windows. The desync trigger is still
unknown. It is worth noting that the two losses were the 3rd and 4th messages of a **brand-new DM**,
in which a second device of the sender's account (A1) was joining, and that the errors say the
sender's generation was one the receiver had **already consumed** - so the suspicion is a ratchet
that goes backwards around early group membership churn, not a random fault. That remains a
suspicion; only the discard policy is proven.

---

## 11. Phase 0 progress - session of 2026-08-05

| Id | State | Detail |
| --- | --- | --- |
| SETUP-1 | **DONE** | `app-universal-debug.apk`, 331 MB, contains `lib/arm64-v8a/libmines_app_lib.so` (313 MB) |
| SETUP-2 | **DONE** | uninstall + clean install, 21 s. `versionName=0.12.0`, `versionCode=12000`, `flags=[DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA]`, `firstInstallTime=2026-08-05 23:50:30` |
| SETUP-3 | **RESTART IT** | started against the USB serial, which then dropped - see the ADB note below |
| SETUP-4 | **DONE** | W1 logged in, PIN accepted, real conversation list rendering |
| SETUP-5 | **DONE** | W2 logged in, PIN accepted, "Aucune discussion" (Claire has no history) |
| SETUP-6 | **DONE** | logged in, PIN accepted, biometrics DECLINED (`native_flags.json` = `{"biometricPromptDismissed":true}`), conversations synced |
| SETUP-7 | **DONE both halves** | section 7 above carries measured names, web and Android |
| SETUP-8 | **DONE** | `a1-baseline/a1-clean-0.12.0.tar`, 43 entries, verified to contain `mls.bin`, the three `canari_<dev>.db*` files, `push_context.json`, `channel_keys.json`, `native_flags.json`, `shared_prefs/` |
| SETUP-9 | **DONE, but not as planned** - see below | community **"Campagne de test"**, channel `general`, exactly two members |

### SETUP-9: why the venue is a COMMUNITY, not a channel in MiTV

The plan said "a dedicated private channel". A private channel is not private enough:

> **"Les administrateurs ont toujours accès à tous les canaux, même privés."**

A private channel inside MiTV was therefore visible to its **five** admins - four real people who
would have received every burst of thirty messages. And no association in the account has jolan as
its sole admin (MiTV 5, MITV 2026-2027 5, ERA and Fanfare are administered by someone else).

So the venue is a **new community, `Campagne de test`**, created from `Ajouter une communauté`
("vous disposerez d'un espace privé pour organiser vos canaux et administrer vos membres"). Its
creator is its only admin. Members: `jolan.boudin` + `claire.vanruymbeke`, nobody else. The stray
channel created in MiTV during the investigation was deleted.

Claire was added through the **invitation link**, not the member search:
`Membres > Générer un lien d'invitation` copies `https://canari-emse.fr/c/join/<token>` to the
clipboard and never renders it, so read it back with `Browser.grantPermissions` +
`navigator.clipboard.readText()` (`clip.mjs`). The user autocomplete
(`#community-invite-autocomplete`, `#user-autocomplete`) returned **nothing** for any query -
unresolved, and worth a look on its own: it may be a real defect or it may need key events that
`Input.insertText` does not produce.

### The harness caveat that could have faked every result

**A page Chrome considers hidden discards every input event.** This was first written up as
"a synthetic click can reach the right element and still do nothing" - `elementFromPoint` returns the
button, `Input.dispatchMouseEvent` lands on its centre, the handler never fires. That description was
right about the symptom and **wrong about the cause**, which matters, because the wrong cause led to
routing around the input path instead of fixing it.

The cause is Chrome's **native window-occlusion detection**. A window that is fully covered by
another window is marked `document.visibilityState === 'hidden'` even though `windowState` is
`normal` and `document.hasFocus()` is `true`, and the renderer then drops CDP input. Two browsers
plus an editor on one screen means at least one of them is always covered, so the failure looks
random. Diagnosis is one line - instrument the target element with capturing listeners for
`pointerdown/mousedown/pointerup/mouseup/click` and dispatch: **zero events** means occlusion, not a
framework quirk.

The fix belongs at launch, not at the call site. Both browsers now start with

```
--disable-features=CalculateNativeWinOcclusion,ChromeWhatsNewUI
--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
```

after which the same `realClick` produces the full **trusted** event sequence and the button opens
its dialog. `realClick` also sends a `mouseMoved` before the press, so the element is hovered like a
user's would be.

### Three more harness faults, found 2026-08-06 - same lesson each time

All three produced a WRONG result that looked like the app's fault, which is why they are written
down rather than quietly patched. The pattern: **the harness must prove it did what it claims**.

**A synthetic pointer never leaves.** `realClick` moves the mouse onto the target and stops there,
so anything that opens on hover stays open forever. The collapsed nav rail expanded over the
conversation list, and from then on every hit-test at a row returned the `NAV`. Read as a layout
bug in the app - a screenshot showed the drawer simply standing open. `realClick` now parks the
pointer at a neutral point after the press (`{ park: false }` where sustained hover is the subject).

**Visible text must beat an `aria-label`.** `RESOLVE` sorted candidates by `innerText` length, so
anything with NO `innerText` won outright - and a DM row ships an avatar labelled
`Avatar de <name>` whose `innerText` is empty. The click therefore landed on the avatar's centre,
which sat under the sidebar, and navigated to `/communities`. Matching on `aria-label` still has to
exist (a community button's `innerText` is its initials); it just must never outrank an element
that visibly says the thing. `RESOLVE` now also **rejects any hit that does not hit-test to itself**
and returns `null` instead, so a caller fails loudly rather than clicking into another subtree.

**A `blob:` URL is not a rendered image.** MSG-4 first passed asserting `blobImgs > 0`. The picture
was in fact broken on every client - the fixture PNG had invalid chunk CRCs, hand-written rather
than encoded - and a broken image has exactly the same `src`. The check now asserts
`complete && naturalWidth > 0`, which is the only thing that proves the encrypt-upload-fetch-decrypt
round trip. The same mistake in the other direction made check M report FAIL on a working surface:
it looked for a `<canvas>`, while the PDF preview is an `<img>`. **Assert the rendered result, and
confirm the fixture before blaming the app.**

This has a direct consequence for the lifecycle checks: **a backgrounded tab must be produced by
focusing another TAB in the same window**, never by covering the window - the flags now make an
occluded window report `visible`, and covering it would no longer emulate anything. And "another
tab" has to be `window.open(..., '_blank')` from the page: `PUT /json/new` + `/json/activate` opens
a separate WINDOW, where both pages stay `visible` and only `document.hasFocus()` flips. Measured,
not assumed; `tabs.mjs` throws rather than run a check that never went to the background.

### ROOT CAUSE, found 2026-08-06: a reload rewinds the sender's ratchet

**WP-FWD-1 and WP-LOSS-1 are one defect, and it is deterministic.** FWD-5 - forward into a
conversation the sender has not opened this session - lost **4 forwards out of 4**, every one with
the identical fingerprint:

```
sender    POST /api/mls/send -> 201
receiver  [RUST::DEBUG] Ciphertext generation out of bounds 110  SecretReuseError
receiver  [MLS] Duplicate for 642f389a... - silent ACK
```

The generation number was **110 on all four runs**. A sender that keeps re-offering the same
generation is a sender whose ratchet went backwards, so the suspect was never forwarding - it was
the `Page.reload` FWD-5 does to get a fresh session.

Two experiments settle it. Neither involves forwarding at all.

**1. It is the first send after the reload, and only that one.** Reload, then send three plain
messages into the DM:

| | delivered | latency |
|---|---|---|
| #0 | **no** | - (`out of bounds 110`, silent ACK) |
| #1 | yes | 630 ms |
| #2 | yes | 660 ms |

A second round immediately afterwards lost nothing - so it is not "every reload".

**2. It is reloading before the state is written.** Prime the ratchet with a send, wait, reload,
then send:

| Wait before reloading | First send after the reload |
|---|---|
| 300 ms | **lost** (`out of bounds 118`) |
| 300 ms | **lost** (`out of bounds 120`) |
| 20 s | delivered, 694 ms |

So: **MLS disk writes are deferred, and a reload that beats the checkpoint restores a state behind
the ratchet the sender already used.** The next message is encrypted at a generation the receiver
has already consumed; the receiver raises `SecretReuseError`, classifies it as a duplicate, and
drops it. `[MLS] Disk writes deferred` has been on the harness's benign list for weeks. It is the
loudest line in the log.

That also retires the load hypothesis and the "forwarding is special" one, and it explains the
original prod report: the three lost forwards fell inside a window with navigation, and the 21
consecutive successes had no reload between them.

**The fix has two halves and both are needed.**

- *The cause*: **SHIPPED and VERIFIED ON PROD** (`a8cc7027`). `scheduleOutboundMlsPersist` now calls
  `persistNow()` instead of `scheduleDeferred()`, so encrypting a message checkpoints the ratchet at
  the point it moved. An unload hook cannot carry this: `pagehide` / `visibilitychange` can only
  *start* an async save (a worker round trip, then IndexedDB) and the document is torn down long
  before it lands - it is a best-effort extra, never the guarantee. `persistNow` still merges
  same-tick calls and stays deferred during a bulk ingest, so a burst of sends costs one checkpoint.
  A ratchet that can go backwards is a correctness bug in its own right - it also means two live tabs
  of the same device can diverge.
- *The consequence*: `secret-reuse` must not mean "duplicate" on its own. Record the fingerprint of
  every ciphertext the LIVE path decrypts - today only the replay path in `history.ts` keeps a
  `seenCipherHashes` set - and on `SecretReuseError` check it: seen means a genuine double delivery
  (real-time publish plus FCM), unseen means the sender rewound.

  **What to do about an unseen one is NOT `onOutOfSync`, and the first draft of this page said it
  was.** The message is unrecoverable at the receiver: its ratchet secret is consumed, so no
  re-fetch, no commit replay and no re-Welcome can ever decrypt those bytes - and a re-add is
  destructive, it tears down a valid membership to fix nothing. Worse, a false positive is easy:
  `seenCipherHashes` is capped at 5 000 entries per group and lives in `localStorage`, so a pruned
  or cleared set turns an ordinary duplicate into a spurious recovery. The useful action is
  detection and a SIGNAL - log it as a desync rather than a duplicate, and tell the sender, which
  is the only party that can send the message again. Designing that signal is what is left; do not
  wire the unseen branch to `onOutOfSync` on the way past.

  Without this half, any future rewind - a crash, two tabs of one device, the mobile background
  service - is silent loss again. With only this half, the sender still wastes a message per reload.

#### Verification of the sender half, on prod, 2026-08-06

Verified with the reproduction that found the bug, not with a new one - `verify-fix.mjs`, three
rounds of prime -> 300 ms -> reload -> send:

| Build | Rounds at 300 ms | Result |
|---|---|---|
| before `a8cc7027` | 2 | **0/2 delivered** (`out of bounds 118`, `out of bounds 120`) |
| after `a8cc7027` | 3 | **3/3 delivered**, 700 / 681 / 772 ms, receiver log clean |

Those latencies are the 20 s control (694 ms), which is the point: the 300 ms round now behaves like
a round with no reload at all. No `out of bounds`, no `SecretReuseError`, no silent ACK.

**Proving the clients ran the build under test is part of the check, and the obvious way failed.**
The script meant to print the entry-bundle hash returned `null` on both sides, so it proved nothing;
the deployment was established from the outside instead - image built `10:38:59Z`, container
recreated `10:40:06Z`, both inside the CD run for head SHA `a8cc7027` (`10:36:01Z` -> `10:40:33Z`),
and the run finished before the harness reloaded either page. **Warm-up is not optional here**: a
priming send made by the OLD build never wrote its checkpoint, so the first round after a deploy can
fail for a reason that is already fixed. Both clients are reloaded once before anything is measured.

#### The receiver half, 2026-08-06: a consumed generation is not evidence of a duplicate

`SecretReuseError` and `Ciphertext generation out of bounds` say exactly one thing - the generation
this frame was encrypted at has already been consumed - and the client answered with a conclusion
the error does not support: *this is a second copy of something I already have*. Two opposite
situations produce that error:

| | What it is | Right answer |
|---|---|---|
| The same frame twice | Real-time publish racing the queue or FCM. Identical bytes. | Drop it silently |
| A rewound sender | A NEW message encrypted at a generation we spent on a different one. Bytes never seen. | It is LOST - say so, and ask for it again |

The frame's own bytes tell them apart, so `inboundFrameLedger.ts` fingerprints every frame this
device manages to process (FNV-1a over the bytes, in memory, 200 per group) and the two branches
that used to log `Duplicate … - silent ACK` now ask it first. A hit is a duplicate and behaves
exactly as before. A miss is a loss, and is logged as `LOST frame` rather than as noise.

**The remedy is on the SENDER, and cannot be anywhere else.** No local recovery brings the plaintext
back - the generation is spent - and `onOutOfSync` would destroy a valid membership to fix nothing.
So the receiver emits a `decrypt_failed` system event, which the sender answers by re-sending what
it kept in `recentSends.ts` (the exact proto bytes, 25 per conversation, 5 minutes).

Three details that make it safe rather than clever:

- **It asks for a WINDOW, not a message.** The frame never decrypted, so the receiver never saw its
  id; `decrypt_failed { withinMs: 120000 }` is a lookback, evaluated against the sender's own clock,
  so nothing depends on two devices agreeing on the time.
- **Answering is idempotent.** The retransmitted proto carries the original `messageId`, and the
  receiver deduplicates on it - so retransmitting something that did arrive is dropped on arrival.
  That is what makes it acceptable to answer a request this imprecise, and what makes a false
  positive cost one frame rather than a duplicate message.
- **One signal per group per 30 s.** A rewound sender fails every frame it sends until its ratchet
  passes what we consumed, and each signal asks for a retransmission - answering a storm with a
  storm.

The ledger is deliberately in memory: the window that matters is seconds, and persisting it would
put an IndexedDB write on the hot inbound path. The cost is stated where it lands - after a reload a
genuine duplicate can be reported as a loss, which costs one idempotent retransmission.

**Native parity was a real gap, not a formality.** `recevoir_message_bytes` classified `SecretReuse`
in Rust and returned `Ok(None)`, which reads to the shared TypeScript pipeline as "nothing to show" -
so on Android every rewound message was dropped with the diagnosis already thrown away. It now
surfaces the error, and the same classifier runs on both platforms. The ACK behaviour is unchanged;
only the diagnosis is.

**Not done, and worth knowing:** the retransmission ring does not survive a reload, so a peer that
reloaded since the send answers `decrypt_failed` with nothing - it logs that the message cannot be
recovered rather than reporting success. And nothing yet tells the RECEIVER's user that a message
was lost; the evidence is in the log.

### ROOT CAUSE, found 2026-08-06: a BACKGROUNDED tab stops receiving, silently (WP-HIDDEN-1)

TAB-4 opened a second tab of the same account and failed twice: the peer's message reached neither
tab, and a send from the first tab reached nobody. Empty logs on both sides, which is the shape of a
harness fault - so it was triaged rather than believed, and the triage found something bigger than
the check it came from.

**The leader received the frame and never processed it.** `[WS RCV] senderId=… protoLen=348` with no
`[QUEUE] Drain start` behind it, three runs out of three, still nothing after 90 s. The path
explains the silence exactly:

- `drain()` sets `isDraining = false` in a `finally`, but **behind** `await hooks.onDrainEnd()`;
- `onDrainEnd` awaits `endBulkIngest()` -> the persister's `onBulkIngestEnd` -> `runSaveEncrypted`;
- `enqueueMessage` only starts a drain `if (!this.messageScheduler.draining)` - and logs nothing
  when it does not. The restart guard at the end of `processQueue` covers messages that arrive while
  `onDrainEnd` is awaiting, but it lives after `drain()` returns, so it cannot help when `onDrainEnd`
  is what hangs.

So one stuck await inside the checkpoint stops all message processing forever, without one line of
output. What hung was the FIRST line of `runSaveEncrypted`: `await yieldToMainThread()`, whose helper
resolved from `requestAnimationFrame` - **which a browser never fires for a hidden document**.

Two candidates were eliminated by measurement, not by reading: IndexedDB answered an open + read in
**1 ms** from inside the stuck tab, and the encrypt worker carries a 60 s timeout that would have
failed loudly and released the drain.

**Two tabs were never the point.** Opening a second tab simply puts the first one in the background.
One tab, backgrounded, reproduces it on its own:

| Step | Result |
|---|---|
| message #1 arrives while hidden | decrypted, `→ addMessageToChat`, then `Bulk ingest done - flushing…` and nothing. It does not even render: the UI flush is buffered by `beginBulkIngest({ bufferUi: true })` and released by the `endBulkIngest` that is stuck |
| message #2 arrives while hidden | enqueued, no drain, no log |
| tab refocused | `checkpoint persisted`, `Drain complete`, both messages appear - at the exact millisecond of the refocus (13:10:53 -> 13:11:19) |

That is a Canari tab left in the background receiving nothing at all, with no error and no hint, until
the user comes back to it - and `yieldToMainThread` is awaited on six paths, including history replay
and the PIN change batches.

**It also retires a PASS.** MSG-8 asserted after restoring the tab, which is the very act that
released the drain, and this page then explained the delay as the browser not painting. Wrong on
both counts. A single message can never expose this; the second one is the whole test.

**The fix** races the frame against a `MessageChannel` round trip instead of choosing between them -
choosing on `document.visibilityState` would still hang whenever a tab is hidden after the callback
is queued, which is precisely what a user does. The fallback is a port message rather than
`setTimeout` because background tabs clamp timers to about 1 Hz, and harder still after a few
minutes, which would turn a hundred-message catch-up into minutes of stalling.

**What is NOT fixed, and is worth a look on its own:** a single hung await inside `onDrainEnd` can
still stop every inbound message with no diagnostic. The flush belongs behind `isDraining = false`,
or the queue needs a watchdog - the yield was one way in, not the only one.

### Two tabs of one account diverge their ratchet, and the loser's message is dropped (WP-MULTITAB-1)

Once WP-HIDDEN-1 was fixed, TAB-4a passed - both tabs render an incoming message. **TAB-4c still
failed, and with the WP-LOSS-1 fingerprint**: the peer never rendered it and logged
`out of bounds 170` + `SecretReuseError` + silent ACK. Same failure mode as the reload rewind,
reached from a different direction.

Nine sends alternating between the two tabs, all on the fixed build:

| Round | tab B sends | tab A sends right after | tab A again |
|---|---|---|---|
| 0 | delivered 1197 ms | **lost**, `out of bounds 172` | **lost**, `out of bounds 173` |
| 1 | delivered 475 ms | **lost**, `out of bounds 174` | delivered 519 ms |
| 2 | **lost**, `out of bounds 175` | delivered 547 ms | delivered 505 ms |

**4 losses out of 9, every one carrying `out of bounds` with a strictly increasing generation.** The
rule is not "the second tab is special" and not "the switch is special" - round 2 lost tab B's send,
which followed tab A's. It is: **a send from whichever tab's in-memory ratchet is behind dies**, and
which one is behind depends on who sent last. A losing send still consumes a generation of its own,
which is why the tab sometimes recovers on its next attempt and sometimes does not.

The cause is structural. Each tab holds its **own** MLS client in memory, both loaded from the same
IndexedDB snapshot, and leadership gates the WebSocket and `initializeConnection` - **it does not
gate sending**. A follower tab encrypts, sends and persists its own checkpoint: the triage caught
`[OUTBOX] Flushing 1 queued entry` / `sent in 642f389a…` / `Encrypted state checkpoint persisted` in
the follower for an entry the LEADER had queued. So the follower is read-only in name only, and one
device's ratchet advances in two places that never learn of each other.

**This is why the single-active-tab design is right and why it was not finished.** One WebSocket and
one MLS writer per device is the correct rule - the WP-LOSS-1 fix makes it more important, not less,
since every send now checkpoints. What was missing is the enforcement on the write path:
`getIsTabLeader()` guarded the connection, and nothing guarded encryption.

Note this is a genuinely different bug from WP-LOSS-1 even though the peer sees the same three lines:
there, one client rewound its OWN state across a reload; here, two live clients of one device each
hold a valid-looking state and overwrite each other. A fix for either does nothing for the other.

#### The fix, 2026-08-06: the follower queues, the leader encrypts

Two halves, because there are two ways a stale in-memory ratchet reaches `sendMessage`.

**The follower must not encrypt.** `runFlush` in `utils/chat/outbox.ts` now returns immediately when
`getIsTabLeader()` is false, before the offline and `canFlush` checks, and posts
`outbox_flush_request` on `canari-tab-messages`; the leader's subscription drains on its behalf.
**The message itself is not transferred** - the outbox lives in IndexedDB, which both tabs already
share, so the follower still writes the entry durably and only the instruction crosses the channel.
That also makes the failure mode benign: if the nudge is lost, the leader's own backoff timer picks
the entry up. The leader answers with `outbox_entry_sent` so the follower can settle the optimistic
echo it is still showing as `pending` - status is derived rather than persisted, so without that
message the clock icon would never clear in the tab that composed it.

**A promoted follower must not send from the state it loaded.** This is the half that is easy to
miss: gating the flush leaves the follower's in-memory client frozen at load time while the leader
advances the ratchet on disk, so the moment the leader tab closes and the follower is promoted, its
first send is stale by exactly as much as the leader did. `setTabLeaderPromotedHandler` therefore
reloads the page instead of only reconnecting the WebSocket, mirroring what the demotion handler
already did. A reload is heavier than a hot `reloadStateFromDisk` - which `TauriMlsService`
implements and `WebMlsService` does not - but it is the only option that provably reloads the state
without swapping a live WASM client under an in-flight operation, and nothing queued is lost because
the outbox is durable.

Guards: three cases in `outbox.test.ts` (a follower never reaches `sendMessage` and leaves the entry
untouched, it still queues and nudges, and the leader announces the send) plus
`composables/tabLeadership.test.ts`, a source guard on the two handlers and on the gate preceding
every other reason a flush could start.

**Verified on prod the same day, twice over**: the script that lost 4 of 9 went 9/9, and
`tab4-mech.mjs` then read both tabs' logs while the follower sent, to check the delegation actually
happened rather than the follower simply not having been behind - see the two rows in section 10.
That second run also cost a harness fault worth keeping: `client(port, 'canari-emse.fr')` takes the
first matching target, and `/json/list` is not in creation order, so a leftover second tab made it
attach to the FOLLOWER and report that the leader had logged nothing. The runner now closes every
extra app tab before it starts. **"The leader" is never the tab you assume; it is the tab that says
so in its log.**

**What the gate does not cover, and why it does not need to:** channel messages bypass the outbox
entirely, but they are not MLS - `sendEncryptedChannelMessage` encrypts under the versioned channel
key with a fresh nonce, so two tabs sending at once is ordinary AEAD, not a shared ratchet. What
does remain uncovered is any FUTURE write path that reaches `mlsService` without going through the
queue: nothing type-checks that. The structural answer to that whole class is one MLS client in a
SharedWorker - noted in `CLAUDE.md`, not scheduled.

### Three more harness faults, from TAB-2/3/6 - all of them "the check measured nothing"

Every one of these produced a confident verdict about something that never happened. They are listed
because the shape repeats: **an action that cannot prove it took effect is worth less than no action
at all**, since it still yields a result.

- **A kill that killed nothing.** `killBrowser` matched on the profile path with the backslashes
  escaped, and PowerShell `-like` treats a backslash as an ordinary character, so the pattern matched
  no process. TAB-3 then reported `browserWasDown: true` about a browser that was up throughout - and
  the "relaunch" was worse than a no-op: a second `chrome.exe` on a live `--user-data-dir` hands its
  URL to the running instance and exits, so the run silently gained a second TAB. Fixed by verifying
  the port stops answering, refusing to start over a live instance, and giving the whole PowerShell
  single quotes (the `-Filter "Name='chrome.exe'"` double quotes do not survive nesting inside
  `-Command "..."`). And the reason it looked like "nothing to kill": `powershell` is not on this
  shell's PATH, and the ENOENT was swallowed by a `catch`.
- **The PIN modal read as a login form.** TAB-3's `LOGIN_SHOWING` tested for
  `input[type=password]` - which `#encryption-pin` is. The unlock modal therefore scored as a
  re-login and failed the check on exactly the distinction it exists to make. It now excludes the
  unlock field and looks for an identifier field or the `/login` route.
- **TAB-6 deleted Cloudflare's cookie.** `canari_refresh` is scoped to `/api/auth`, so
  `Network.getCookies { urls: ['https://canari-emse.fr'] }` never returns it; the only httpOnly
  cookie visible there is `cf_clearance`. The check deleted that, reloaded, saw the app still logged
  in and called it a silent-empty-list failure. `Storage.getCookies` returns the whole jar, and the
  cookie is now matched by NAME, with an explicit throw if it is absent or survives the delete.

A fourth, from the same afternoon: `client(port, 'canari-emse.fr')` takes the first matching target
and `/json/list` is not in creation order, so a leftover second tab made the multi-tab check attach
to the FOLLOWER and report that the leader had logged nothing.

### The LIFE phase opens: what `force-stop` actually tests, and what it found (2026-08-06)

**`am force-stop` is not "the user killed the app".** Android puts a force-stopped package into the
STOPPED state and withholds every broadcast from it - including FCM - until a manual launch. The
proof is in the log rather than in the app's silence:

```
15:39:15 W GCM: broadcast intent callback: result=CANCELLED
                forIntent { act=com.google.android.c2dm.intent.RECEIVE pkg=fr.emse.canari }
```

The push was delivered TO THE DEVICE and cancelled by the framework. So LIFE-3 as written measures
an OS policy, not the app: **NOTIF-1 and every other "app killed" cell must use a swipe from
recents** (which does not set the stopped flag) **or `am kill`** (LIFE-8, the OS reclaiming the
process). A check that force-stops and then reports "no notification" is reporting Android's
documented behaviour as a Canari bug.

**The half that is ours, and is new: an unrefreshable session leaves the Android app looking
signed in.** After that relaunch the very first refresh was rejected -

```
15:40:16.970  [A] refresh→ https://canari-emse.fr/api/auth/refresh
15:40:17.959  [A] refresh✗401 988ms
15:40:18.572  [API] refresh failed on GET /api/users/… - session expired
15:40:20.138  [PIN] No device key in vault - auto-login impossible
```

- and the app then rendered the **feed**, not a login screen, while looping one refresh attempt per
second and serving every request `proceeding without auth`. `pin.mjs` found no unlock modal and the
body was the ordinary logged-in shell. The conversation was empty: the DM sent while the app was
down never appeared, which to a user is indistinguishable from nobody having written.

That is the failure TAB-6 exists to catch, and the web passes it: deleting `canari_refresh` there
lands on `/login` with "Se connecter". **The two platforms disagree**, so this is WP-ANDROID-SESS-1.

#### Root cause, settled the same day: the on-disk cookie lags one rotation

The 401 was a **replay**, and the server says so in its own words - same second as the phone's line
above:

```
08/06/2026, 1:40:16 PM  WARN [AuthSessionsService]
  Refresh token replay detected sid=19c9438d-… user=d82cd226… - session revoked
```

Corroborated by the table: of the four Pixel 6a rows for that user, none is later than
2026-08-05 16:43 UTC. The 08-06 row is gone, deleted by the replay branch.

**Why a replay.** The refresh token exists in exactly one place on Android - the WebView's Chromium
cookie store - and Chromium commits that store on a lazy timer. `MainActivity` calls
`CookieManager.flush()` from `onPause`/`onStop` and nowhere else, so a rotation performed while the
app is FOREGROUNDED lives in memory only. `am force-stop` runs no lifecycle callback, so the next
cold start reads the cookie from before that rotation.

Proven both directions with `sessprobe.mjs`, **without ever reading the token**, by using the
server's own 60 s grace window as the instrument: force a rotation from the page, kill and relaunch
inside the window, then read the row back. If the row has not moved, the phone presented the
superseded token and the server merely re-issued (grace); if it has, the phone presented the current
one.

| run | before the kill | rotation forced | row afterwards | reading |
| --- | --- | --- | --- | --- |
| 1 | nothing | 14:28:38.775 → 200 | `tokenId 63a46f92…`, `rotatedAt 14:28:39` - **only my rotation** | relaunch was a grace REISSUE → **disk was stale** |
| 2 | HOME (fires `onStop`) | 14:29:29.672 → 200 | `tokenId 5d669b5a…`, `rotatedAt 14:29:37` - a **second, real** rotation | relaunch presented the current token → **disk was current** |

Inside 60 s the grace window hides the whole thing. Outside it, the same stale cookie is a replay and
the session is destroyed - which is exactly what LIFE-3 walked into, and exactly what the model in
[sessions](sessions.md) prescribes. Hypothesis 2 (concurrent cold-start refreshes replaying one
token) is dead: the first 401 precedes any concurrency, and run 1 reproduces the staleness on its
own.

**There are two defects, and the second is the one the user sees.** They are independent, and the
second would have been just as wrong if the token had been fine:

1. **Persistence.** The rotated credential is not durably written before it is relied upon. Fixed by
   flushing the WebView cookie jar after login, after every refresh, and after logout - awaited, via
   a `flush_webview_cookies` Tauri command that reaches `android.webkit.CookieManager` over JNI.
2. **Visibility.** A dead session must land on `/login` everywhere. `apiFetch` swallowed
   `SessionExpiredError` and re-issued the request unauthenticated (`proceeding without auth`); the
   route guard only redirects when no user id is cached; and the Android reconnect path returned at
   `No device key in vault` before `getToken()` was ever called, so nothing raised the error that
   redirects. The web passed by accident - its device key is in the browser vault. The verdict is now
   announced once from the single place that reaches it (`setSessionExpiredHandler`), and only a
   TRANSPORT failure earns an anonymous retry.

**Two traps this cost.** Reading the cookie off the device is refused by the classifier, and rightly
so - it is a live credential; the grace-window probe answers the same question and touches nothing.
And `ssh canari` is impossible from the Bash tool (Git Bash strips the backslashes out of the
cloudflared ProxyCommand path): every prod query goes through the PowerShell tool, single-quoted
outside with SQL literals doubled (`''uuid''`), or the quoting shreds the statement.

#### Verified on the device, 2026-08-06 - and the verification found a third defect

The APK carrying both halves was flashed at 18:58 (`JNI_OnLoad` exported from `libmines_app_lib.so`,
`android/webkit/CookieManager` and `flush_webview_cookies` in its strings). A compile could not have
told us the one thing that mattered, and the first cold start did: **`[Cookies] flushed after
refresh`** in the app's own console, so `FindClass` resolves and `CookieManager.flush()` returns from
a native thread.

**Persistence - 2/2.** The reproduction that killed the session, run against the fixed build. Session
`c64b1934…`, no lifecycle callback at any point (`am force-stop`, never HOME):

| round | rotation flushed | killed | relaunched | row afterwards | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | `917bd5aa…` at 18:59:21 | 19:00:28 | 19:02:11 (**94 s**) | `tokenId fecea263…`, `previousTokenId 917bd5aa…` | the phone presented the CURRENT token → **real rotation**, row alive |
| 2 | `fecea263…` at 19:02:11 | 19:02:53 | 19:04:40 (**107 s**) | `tokenId 4d80f6a6…`, `previousTokenId fecea263…` | idem |

`previousTokenId` is the whole proof: it is exactly the token the app flushed, so the cookie the
phone read back after the kill was the current generation, not the one before it. Both gaps are well
past the 60 s grace window, so neither is a reissue. No `Refresh token replay detected` in the
server log for the window.

**Visibility - PASS, and it exposed defect 3.** The session was then revoked the way a user would -
another client's `/settings` → "Connexions actives" → "Déconnecter" on the phone's row - and the
phone cold-started. It reached `/login`, with `[A] session dead → logout` and
`[API] session expired on GET /api/users/… - no anonymous retry`. **But the log also said
`no session-expired handler registered - redirecting directly`, and the encryption-PIN modal was
still open over the login screen**, covering the sign-in button: signed out, with nothing to press.

3. **The verdict beat its own handler.** `ChatBackgroundService` registers the reaction on mount, and
   a cold start's first refresh 401s before that - so the fallback ran, and a bare `goto('/login')`
   is not the reaction: it skips `dismissAuthPrompts()` and `clearAuth()`. `setSessionExpiredHandler`
   now replays the verdict to a handler that arrives after it. **A one-shot announcement plus a late
   subscriber is a race**, and a fallback only covers it if it does everything the handler does -
   which it never does, or it would be the handler.

Two things the campaign should carry from this. **A fix's own verification is a check like any
other**, and its observation log gets read the same way - defect 3 is in the same paragraph as the
PASS that found it. And **exercising the failure branch costs a real logout**, so know the re-login
path before you take it: it goes through the SYSTEM browser, not the WebView (`auth.ts` launches it
with `openUrl`), so the CDP port must be forwarded to `localabstract:chrome_devtools_remote` and
`login.mjs` driven with `--match cas.emse.fr` there. It is ordinary automation - the harness has done
it repeatedly - with ONE trap that cost a run here: **do not `realClick` the CAS fields.** On the
phone's narrow layout the hit test resolved to the "mot de passe oublié" link beside the password
box and navigated away mid-fill, which then surfaced as a null `#username` on the next read rather
than as a wrong click. CAS is a third-party form, not the system under test, so focus the fields by
element and assert `document.activeElement` - the same reasoning `login.mjs` already applied to the
submit button, and had simply not extended to the inputs.

### Three more harness faults, from the LIFE phase - all in reading the phone

- **A dump too big to read is not an absent notification.** `dumpsys notification --noredact` is over
  a megabyte on this device, which is exactly Node's default `maxBuffer`, so `execFileSync` threw
  ENOBUFS and LIFE-2 died with a stack trace instead of a verdict.
- **A truncated dump is not an absent notification either.** The notification reader matched against
  the first 900 characters of each record; the marker sat past that, so LIFE-2 reported "no
  notification" while the very same dump carried the title `Claire VAN RUYMBEKE` and the marker in
  the body. Checks now match on the full record and only PRINT the truncation.
- **`pidof` exits 1 when the process is gone**, so the un-caught form threw exactly in the case the
  LIFE phase exists to create: the check died on the kill instead of measuring it.

`--noredact` is not optional, by the way: without it the OS hides the text of notifications it
considers sensitive, and a decrypted notification then reads as an empty one.

**Reading the phone's web console does not need the WebView to be reachable**: every line reaches
logcat under the tag `Tauri/Console`, which is the only way to see what the app did while it was
killed, backgrounded or dozing.

### Cutting the network: which side the browser can fake, and which it cannot

`Network.emulateNetworkConditions { offline: true }` fails every NEW request within ~10 ms, so it
models an offline **sender** exactly - a send is a new request - and MSG-10 runs on it happily,
including the `webSocketClosed` the sender observes.

It did **not** model an offline **receiver**: MSG-9 twice showed W2 rendering a message while
`navigator.onLine` was false and a probe `fetch` failed in 3 ms. The cause is not established -
the mirror-image run on the sender does close its socket - so do not repeat the explanation that
was first written here. What matters is the rule: **prove the cut, and prove it on the side you are
cutting**. `net.mjs` returns a `severed` flag from a real failed request rather than trusting the
command, and MSG-9 moved to the phone, where `svc wifi disable` + `svc data disable` is
unambiguous and is also what a user actually experiences.

Cutting the phone costs one thing: **adb must be on USB**, because the wireless transport dies with
the wifi. The USB link on this device drops on its own, so re-establish
`adb -s <usb> forward tcp:9222 localabstract:webview_devtools_remote_<pid>` before the run, and
expect `/json/list` to hang if the screen has gone to sleep - wake it and foreground the app first.

### Two more, from MSG-8b - and they cost an invented app bug

MSG-8b first reported a message the sender had and neither other device did - the shape of
WP-LOSS-1, in a check that was not even about loss. Both causes were mine.

**The composer is inside the pane, so its text read back as a delivered message.** `PANE_TEXT` was
`section.innerText`, and the section contains the composer. A send that never submitted therefore
"arrived": `countMessage` returned 1, and `awaitMessage` would return instantly on any sender. The
triage that was supposed to catch it repeated the same mistake and reported the sender as holding
its message - it was holding a draft. `PANE_TEXT` now subtracts the composer's own text.

**The send button moves 350 px under the measurement, and coordinates cannot follow it.** Focusing
the composer opens the soft keyboard; on Android that shrinks the VISUAL viewport (914 -> 572) while
the LAYOUT viewport stays 914. The page positions the composer bar above the keyboard, so
`getBoundingClientRect` reports the send button at y=511 - correct - while
`Input.dispatchTouchEvent` addresses the layout viewport. The touch is delivered, lands on `<html>`,
no click is synthesised, and the draft stays in the box. Re-reading the rect until it is stable and
hit-testing it does **not** save it: the coordinate systems genuinely differ. So `send()` uses
`activate()` for the submit control, which is what the rule above already prescribes - the input
path is not what a delivery check is testing, and it is verified on device separately.

Two consequences worth stating plainly:

- **Every action must assert its own post-condition.** `send()` now fails if the composer still
  holds text. Three assertions later, the cause is off screen and the verdict is a fiction.
- **A control that is `disabled` for a tick swallows the click.** Svelte re-enables the send button
  after the input event, so `send()` waits for the state, not for a delay - and a probe run against
  an empty composer sees "no click" for that reason alone, which sent this investigation down a
  false trail for several rounds.

Two explicit primitives remain, and the rule for choosing is now about intent rather than
reliability - never a silent fallback between them:

- `realClick()` - real input events, and the default: it works.
- `activate()` - `el.click()`, only where the effect is all that matters and the page is
  deliberately hidden (a backgrounded tab under test).

**The same class of mistake bit the reading side.** The contact autocomplete was recorded in Phase 0
as "returns nothing for any query". It returns results correctly: `GET /api/users/search?q=Claire`
answers `200` with both matches, and the list renders in a **portalled dropdown outside
`[role="dialog"]`** - the read was scoped to the dialog, so it saw an empty one. Scope pane reads to
the right root, and confirm a negative against `document.body` before believing it.

And on the mobile PIN modal, **prefer `Saisie manuelle` to the keypad**. The keypad has no readable
buffer, so nothing can assert what it holds; leftovers survive between attempts, and after a failed
try the first tap dismisses the error instead of entering a digit - so four blind taps submit a
three-digit PIN and the run reports "PIN incorrect" for a PIN that is correct. Switching to the text
field makes the value settable AND readable.

Two more, cheaper:

- Every CDP call appeared to take **30 s**: an armed 30 s timeout timer keeps Node's event loop
  alive after the reply arrives. Clear it (and `unref` it). 30 s -> 0.2 s.
- The device's default browser was Firefox, which exposes no CDP. Chrome is installed, so the login
  flow is driven by making Chrome the default
  (`cmd role add-role-holder android.app.role.BROWSER com.android.chrome`) and forwarding
  `chrome_devtools_remote`. **Restore Firefox at the end of the campaign.**

### What Phase 0 cost, and must not be re-learnt

- **`--target aarch64` emits the `universal` flavour, not `arm64`.** The `apk/arm64/debug/`
  directory still holds a **stale July APK**, and installing it would silently test the wrong build.
  Always install `apk/universal/debug/app-universal-debug.apk` and check its mtime.
- **The build's jniLibs symlink SUCCEEDED here**, so `_ensure_native_lib_present`'s rescue copy was
  not needed - but verify the `.so` is inside the APK (`zipfile`, `lib/arm64-v8a/`) rather than
  assuming either way.
- **The 0.11.6 that was on the device was a RELEASE build**: `run-as` refuses it
  ("package not debuggable"), so **no old-format `mls.bin` could be salvaged before the wipe**.
  CORRUPT-5 has no artefact source from this device and needs one built deliberately.
- **USB ADB drops on this phone.** Immediately after connecting, promote to wireless and use that
  serial for everything: `adb tcpip 5555` then `adb connect <ip>:5555` (`192.168.1.185:5555` on this
  network; the device IP comes from `adb shell ip route`). Also `adb shell svc power stayon true` and
  a 30-minute `screen_off_timeout`. A background logcat bound to the USB serial dies with the cable.
- 2FA was asked once, on W1, and answered by hand. Both browser profiles are persistent.

## The LIFE phase, 2026-08-06

Run against the APK reflashed at 19:47:48 (data preserved, `firstInstallTime` unchanged). One check
per run, each read next to its own observation log.

| check | state entered | notification | in the conversation | verdict |
| --- | --- | --- | --- | --- |
| LIFE-3 | `am force-stop` | none, **as expected** | once, 81 ms after restore | PASS |
| LIFE-4 | doze (`force-idle`, unplugged, screen off) | decrypted text, 4.6 s | once, 26 ms after restore | PASS |
| LIFE-7 | `POST_NOTIFICATIONS` revoked | none, **as expected** | once, 61 ms after restore | PASS |
| LIFE-8 | `am kill` (from HOME) | decrypted text, 4.7 s | once, 52 ms after restore | PASS |
| LIFE-6 | radios off (`svc wifi/data disable`) | none | **never - 3 runs, 3 losses** | FAIL |
| LIFE-6 **re-run**, 2026-08-06 22:16, after all four fixes | radios off | none, as expected | **once, 18 ms after restore** | **PASS** |

The LIFE-6 re-run is what closes the phase, and its log is the point rather than its verdict: the
message is drained by the new per-page path (`[PENDING] Fetched 2 pending messages (2 so far)`),
then `Drain start … 2 processed … Drain complete` in 2.8 s, with **no** `LOST frame`, no
`SecretReuse`, no `out of bounds` and no re-add. The three earlier losses were the 2 000-generation
debt WP-PENDING-1 had made undrainable; with the group rejoined at a fresh epoch and the drain
making progress per page, the ordinary offline path is finally what the check measures - which was
the whole reason to re-run it rather than trust the fix.

LIFE-3's empty shade is Android policy, not a Canari fault: a force-stopped package sits in the
STOPPED state and the framework cancels every FCM broadcast to it until a manual launch. "The user
killed it" is LIFE-8.

## The NOTIF phase, 2026-08-07

| check | verdict | numbers |
| --- | --- | --- |
| NOTIF-4 | **FAIL x3**, then **PASS** on the fixed build | dismissed 263 ms after the read |
| NOTIF-9 | **PASS** | killed in 77 ms, notified in 18.1 s, shade 1, W1 1 |
| NOTIF-10 | **PASS on delivery** (10/10 across two rounds), with one open observation on the shade | see below |
| NOTIF-7 (backgrounded) | **PASS** | notification decrypted in 18.1 s, tap -> right conversation in 8.4 s, 1 copy |
| NOTIF-7 (killed) | **FAIL - a real defect, WP-DEEPLINK-1** | notification decrypted in 7.0 s, tap -> the app opened on the FEED and stayed there for 69 s |
| NOTIF-7 (killed), re-run on the fix | **PASS** | shade in 6.9 s decrypted, tap on a proven target, PIN gate answered in 7.8 s, conversation + marker **6.2 s after the unlock**, 1 copy |

### NOTIF-7: the deep link works from a backgrounded app and NOT from a killed one

This is `check H` of [device-verification](device-verification.md), owed since it has only ever been
verified by compiling. The product has no `/c/<id>` route - a notification tap publishes to
`notifNav` - so the only honest test is to tap the real notification and read where the app lands.

**The discriminator, and why it is not optional.** The app is parked on `/posts` before it is
backgrounded or killed. If A1 were already in the DM, "the DM is on screen afterwards" would be true
whether the deep link fired or did nothing at all.

| | backgrounded | killed |
| --- | --- | --- |
| notification in the shade | 18.07 s | 6.96 s |
| body decrypted (real text, not the fallback) | yes | yes |
| app foregrounded by the tap | yes | yes |
| landed on | `/chat`, marker present | **`/posts`, marker absent after 69 s** |
| copies of the message | 1 | 0 |

So the notification itself is healthy in both cases - posted, decrypted, tappable, and it does bring
the app to the front. What is broken is only the **cold-start** leg of the navigation.

Three things this cost, all of them harness rather than app:

- **The sender must be the PEER.** The first run sent from W1, which is jolan's *other* device, so
  the phone classified it as the user's own message and suppressed the notification exactly as it
  should: `senderName=Jolan BOUDIN silent=true` then `FCM silent from self -> cancelling
  notification`. The check reported "no notification ever reached the shade" against a build that
  was behaving correctly.
- **W1 must be OFF the conversation.** Left sitting in the DM it marks the message read on arrival,
  which pushes a cross-device dismissal to the phone - the very mechanism NOTIF-4 verifies - and
  that push arrived *before* the message push it was cancelling. It also contends for the MLS state
  lock: `tryDecrypt: MlsStateLock not acquired after 5s -> abort (another thread is decrypting)`,
  three times, and the run ended on the generic fallback (`Nouveau message de Claire VAN RUYMBEKE`)
  where the clean run decrypted. Worth remembering when reading any background-decrypt measurement:
  **a concurrent silent push can starve the decrypt of its own lock.**
- **uiautomator2 cannot tap the shade on this device.** Its on-device agent dies with
  `RemoteDisconnected` right after the shade is expanded, twice out of two, *after* the dump has
  succeeded. So the dump supplies the coordinates and the tap goes through plain `input tap`, which
  involves no agent. A tap that finds no row returns `ok: false` rather than a verdict.

#### The 20th harness fault: `.chat-composer-editor` is on the FEED too

The post-condition added after the 19th fault - "the composer must be on screen, or refuse a
verdict" - was itself unable to tell the two screens apart. `.chat-composer-editor` is a class of the
**shared** `MentionComposerInput`, which `/posts` uses for its "Ajouter un commentaire…" boxes, so
`composer: true` was returned while the app sat on the social feed. NOTIF-7 killed only failed
correctly because `marker` and `count` carried the verdict independently.

The consequence that had not happened yet is the serious one: `send()` uses the same selector, so a
check that misnavigated would have typed its marker into a **comment box on somebody's post**.

Fixed in `chat.mjs`: every use is now scoped to `.chat-composer-footer .chat-composer-editor`, a
class that belongs to `ChatComposer.svelte` alone. The general rule, which this page keeps paying
for: **a selector shared by two surfaces is not a post-condition.**

#### The 21st harness fault: `a1.py` guessed which device to drive

Promoting the phone to `adb tcpip 5555` - which every long run must do, because its USB link drops on
its own - leaves **two** transports attached, and `u2.connect()` with no serial delegates to adbutils,
which raises rather than choosing:

```
adbutils.errors.AdbError: more than one device/emulator, please specify the serial number
```

It aborted a NOTIF-7 run *at the tap*, with the notification it was meant to tap already found and
sitting in the shade - and the same drop later hung two more commands, because `phone.mjs` resolves
its serial once at import and every `adb -s <dead usb serial>` after that fails. `a1.py` now resolves
the device explicitly (`ANDROID_SERIAL` if set, else prefer the wireless entry) and `phone.mjs`
exports its `SERIAL` so the native driver is pointed at the same transport. The rule is the one this
page keeps restating: **a locator is a guess unless it is disambiguated** - a device is a locator too.

#### Root cause (2026-08-07): the deep-link plugin was never granted its permission

Every hop in the chain is healthy, and the log proves each of them separately. From a run captured
with a continuous `logcat` while `notif7.mjs killed` executed:

```
08:01:15.489 WIN DEATH: Window{... fr.emse.canari/fr.emse.canari.MainActivity}   <- the kill
08:01:28.008 START u0 {act=android.intent.action.VIEW dat=fr.emse.canari://chat/...
                       cmp=fr.emse.canari/.MainActivity} with LAUNCH_SINGLE_TASK    <- the tap
08:01:28.104 MainActivity(10665): onResume: isInForeground=true                    <- cold start
08:01:28.928 Tauri/Console(10665): [hooks] Deep-link listener registered           <- the WebView
```

The PendingIntent carries the right action and the right data, and the activity is created by it. And
then nothing: `[hooks] onOpenUrl called`, `[hooks] Processing URL` and `[notifNav] deep link received`
are **absent from the entire capture**. The URL never crosses into JavaScript, so `notifNav` is never
published - which also kills the first hypothesis this WP was opened with (a late subscriber missing
a one-shot announcement). There is no announcement to miss.

Asked directly, over the internal invoke, on the very process the tap had started:

```json
{ "url": "http://tauri.localhost/posts", "hasInternals": true,
  "getCurrentThrew": "deep-link.get_current not allowed. Permissions associated with this command:
                      deep-link:allow-get-current, deep-link:default" }
```

**`deep-link` had no entry in `capabilities/default.json` at all.** Tauri v2 gates plugin *commands*
behind an ACL; the dependency in `Cargo.toml` and the five schemes in `tauri.conf.json` grant
nothing. The asymmetry that hid it for as long as it existed is the interesting part:

| path | mechanism | ACL-gated | worked |
| --- | --- | --- | --- |
| app already running | `onOpenUrl` - an event channel the Rust side registers | no | yes |
| cold start | `getCurrent()` - a plugin **command** | **yes** | no |

So the failure is invisible to every way of checking it that involves having used the app first, and
it is not Android-specific: iOS runs the same capability file and the same `hooks.client.ts`, and has
never been checked at all (`check H` in [device-verification](device-verification.md)).

`hooks.client.ts` then made it unobservable: `checkCurrentUrl` ended in `.catch(() => {})`, so a
rejected invoke and "this launch carried no URL" were the same silent outcome, on a path that runs
five times per start. That is the durable rule about capability probes, paid for a second time -
the fix logs the failure once per distinct message.

Fixed in `916ed696`: `deep-link:default` (which is exactly `allow-get-current` - the one command a
cold start needs) is granted, the catch logs, and `tauriCapabilities.test.ts` asserts that every
plugin in `Cargo.toml` exposing commands is granted in a capability file. `localhost` is the single
exemption, in writing, because it has no JS surface. Negative control: removing the grant fails two
of its three assertions.

#### The 22nd harness fault: the check measured the screen BEHIND the PIN modal

Raised by the user, looking at the phone while the verification ran: *"le modal PIN est affiché, tu ne
le tapes pas ?"*

`notif7.mjs` unlocks during setup and then **kills the app**, which spends that unlock: the cold start
the tap produces re-locks. Nothing in the check typed the PIN afterwards, so `landed.composer`,
`landed.marker` and `count` were all read through the modal for the full 69 s window - every one of
them false, for a reason with nothing to do with the deep link. **The verdict would have been
identical against a fixed build**, which is what makes it a fault and not a detail: it was not
measuring what it named.

The FAIL it produced was nonetheless real, and the user confirmed it - but only because a *separate*
instrument said so. `[hooks] onOpenUrl called` is a plain `console.log` that reaches logcat whether or
not a modal is on screen, and it is absent from the entire capture for pid 10665. **The diagnosis
survived because it never depended on the broken measurement.**

Two rules, and the second is the one that costs:

- **A check that locks itself out must unlock itself.** Every assertion now waits for the PIN gate or
  the composer, whichever settles first, and unlocks if it is the gate - so a warm `bg` run pays
  nothing and a cold `killed` run is measured on the same footing. The elapsed time is split in two,
  because it answers two questions: `deepLinkMs` is what the user waits from the tap (PIN entry
  included, honest but uninformative about the deep link), `landedAfterUnlockMs` is the navigation
  itself, and only the second is comparable between `bg` and `killed`.
- **This lesson had already been learnt, one script over.** NOTIF-10 recorded it verbatim two sections
  below - *"the radios coming back RESTARTS the app, and a restarted app re-locks the encryption
  PIN"* - and the fix went into `notif.mjs` only. A precondition discovered by one check is a
  precondition of **every** check that puts the app through the same transition; fixing it where it
  was found and nowhere else guarantees it will be paid for again. A kill, a reboot, a radio cycle and
  an `install -r` are all the same transition here.

#### The 23rd harness fault: the check asserted THAT something changed, never WHERE

Raised by the user, from the phone, minutes after a green verdict: *"pincher augmente le zoom, mais
ca augmente pas a l'endroit qu'on veut"*.

`check-pdf-pinch.mjs` asserted `width% 100 -> 300` and `imgW 395 -> 1186`. Both true, both real -
the 3x on the page image even proves the page genuinely re-rasterised rather than being CSS-stretched
- and both **completely silent about the property the feature exists for**. A pinch that zooms about
the top edge passes that check identically to one that zooms about your fingers, so the verdict
carried no information about the thing the user was about to complain about.

This is the same shape as fault #22 (a verdict that would be identical against a fixed build) but
arrived from the other side: #22 measured the wrong screen, #23 measured the right screen and asked
it the wrong question. **"Did the state change" is almost never the assertion; "did it change into
the right state" is.**

The replacement, `check-pdf-anchor.mjs`, is worth copying as a pattern:

- It identifies a **content point** before the gesture - a page index plus the fraction within that
  page's box - and re-locates the same point afterwards. That formulation survives a re-layout, which
  is the whole difficulty: the pages are re-rasterised, so nothing about their pixels is comparable.
- It is deliberately **independent of the implementation's formula**. Re-deriving the app's own
  arithmetic in the check would only re-test the unit tests; measuring the drift tests the wiring.
- **It was validated as a NEGATIVE CONTROL first**, against the build still carrying the defect:
  drift `(395, 1370)` px. Only then were its later verdicts meaningful. A check whose failing case
  has never been observed is a check that has not been tested.
- Its tolerance is set from those measurements, not from taste: 12 px, which fails against the
  no-correction build **and** against the intermediate ratio-based one (49 px). A tolerance chosen
  loosely enough to pass everything is the fault all over again.

The intermediate result is itself the reason this matters. The first fix cut the drift from 1370 px
to 49 px - visually a night-and-day improvement, and something a human spot-check would have called
fixed. The check refused it, and the 49 px turned out to be a real second defect with a growing
error: a ratio-based scroll correction assumes the whole document scales, and the fixed `py-3` /
`gap-3` gutters do not, so the overshoot is `(ratio - 1) x (padding + gutters above the pinched
page)` - 48 px on page 2 at x3, ~192 px by page 8. **A measurement tight enough to be uncomfortable
is what found it.**

#### The 24th and 25th harness faults: both locators, opposite verdicts

Both came from the same hour, on the two checks written for the PDF re-render and the feed retry,
and together they say the thing worth keeping: **a locator failure does not bias a verdict in a
predictable direction.** One produced a PASS, the other a FAIL, and neither had anything to do with
the app.

**#24 - a PASS on a ladder that was never walked.** `check-pdf-render.mjs` drives the zoom ladder,
samples the first page every 16 ms and asserts it is never blank and never re-rasterises more than
once. It returned `PASS (blank/cut frames 0/478, bitmaps 1)` against the build still carrying the
defect - because its button selector was `/zoom/i`, and the control's `aria-label` is **`Agrandir`**
(its sibling is `Reduire`). Nothing was clicked, the document sat perfectly still at 100 %, and
"never blank, at most one bitmap" was trivially true of a page nobody had touched. The log even said
so - `clicked: "none"` at all three steps - and the verdict line printed over it anyway. The fix is
not the selector: **every step now asserts its own post-condition** (the click reports `clicked` AND
the column's `width%` strictly grew), and a ladder that did not move exits `INVALID` before any
verdict is computed. The same run against the fixed build then read `473/475 -> 0/474` blank frames,
which is what the check existed to say.

**#25 - a FAIL against a page that was visibly working.** `check-feed-retry.mjs` counted recovered
posts with `document.querySelectorAll('[data-post-id], article')`. The feed has neither: `PostCard`'s
root carries `group/card`. So the check reported `FAIL (posts rendered = false, cards 0)` on a run
whose own other fields already contradicted it - `errorScreen: false`, `knownPost: true`. Reading the
evidence next to the verdict, rather than the verdict, is what caught it in one step.

The generalisation, and it is the fourth time this campaign has paid for it: **a selector written
from the outside is a guess about markup you have not read.** `aria-label` guessed from English,
`article` guessed from what a feed "should" be - both wrong, both silent. Where a check names an
element, name it from the component source, and give the check enough post-conditions that a locator
that matched nothing cannot reach the verdict line.

#### Verified on the device (2026-08-07): the cold-start deep link lands

Captured on the rebuilt APK (`lastUpdateTime 08:55:12`, bundle `app.DR0TKxSY.js`), pid 15059, from a
notification tapped with the app killed:

```
08:56:32.621  [hooks] Deep-link listener registered
08:56:32.628  [hooks] onOpenUrl called with 1 URL(s)
08:56:32.628  [hooks] Processing URL: fr.emse.canari://chat/642f389a...
08:56:32.630  [notifNav] deep link received: ... -> target 642f389a...
```

All three lines that were absent before, 7 ms after the listener is registered - i.e. the immediate
`checkCurrentUrl()`, which is the `getCurrent()` path the grant unblocks, not the event.

The rest of that capture answers a question the check does not ask, and it is worth more than the
verdict: the PIN modal came up at 08:56:33 and **was not answered until 09:01:41**, five minutes
later. Four seconds after the unlock, `[OUTBOX] Queued 58870a4f... (control) for 642f389a...` - a read
receipt in that exact group - and the conversation was on screen. **`notifNav` held its target across
five minutes of an unrelated modal.** That is the durable-store property being exercised on hardware,
and it is the final nail in the retired "late subscriber" hypothesis: the target survives an
arbitrarily late consumer, so a missed announcement was never a possible cause.

The formal re-run then passed on the repaired harness: shade in 6.9 s (decrypted), a tap with a
proven target, the PIN gate answered in 7.8 s, and the conversation with its marker **6.2 s after
the unlock**, one copy. Both browsers clean.

#### And the re-run's own log found a second defect: a reload REPLAYS the launch deep link

The setup step parks A1 on the feed - *"so a default route cannot fake the verdict"* - and the run
reported `beforeUrl: /chat` right after navigating to `/posts`. The parking had not failed; something
had navigated back. The capture names it, and it is not the process under test:

```
09:12:02  Tauri/Console(15059): [hooks] onOpenUrl called with 1 URL(s)      <- the OLD process
09:12:02  Tauri/Console(15059): [notifNav] deep link received: ... 642f389a...
09:12:27  Tauri/Console(17041): [hooks] onOpenUrl called with 1 URL(s)      <- the tap under test
```

pid 15059 was launched by a notification at **08:56** and consumed that target at 09:01. The harness
reloaded its WebView at 09:12 - and `checkCurrentUrl` re-published the same fifteen-minute-old launch
URL. `getCurrent()` does not mean "this app was just started by a deep link"; it means "the last deep
link this PROCESS was handed", and the Rust plugin holds that for the life of the process. The guard
against replaying it was a module variable, which a WebView reload wipes - **erased by precisely the
event it existed to survive.** The comment above it said it was there to stop a replay on foreground
resume; that case works, because a resume keeps the bundle alive.

This is not harness-only. The in-app reload paths are `MlsFatalErrorBanner`'s action (the likeliest
on a phone: a user repairing an MLS error), the version-mismatch reload in `appVersion.ts`,
tab-leadership demotion in `useChatSession`, and the `Ctrl+Shift+S` sync reset. Any of them, in a
session that was launched from a notification, silently teleports the user into that conversation.

Fixed by moving the claim into `sessionStorage` (`$lib/mobile/deepLinkClaims.ts`), whose lifetime is
exactly the plugin's: it survives a reload of the same WebView and is empty in a new one, so a
genuine cold start still processes its launch URL. Seven unit tests, including both boundaries
(same storage -> no re-claim; fresh storage -> claim) and a storage-denied fallback. Negative
control: reverting to memory-only fails the reload test and nothing else.

The rule generalises past deep links: **state whose job is to survive an event must not live where
that event destroys it** - and "module variable" is a lifetime, not a detail. Same family as the MLS
disk-write deferral of WP-LOSS-1, where the durable copy lagged the in-memory one.

### NOTIF-10, settled: every message survives a ten-minute blackout; the SHADE does not show them all

Two independent ten-minute rounds, five messages each, sent while the phone had both radios off.
Counted on 2026-08-07 06:40 with the conversation asserted on screen (composer present):

| round | markers | count on A1 |
| --- | --- | --- |
| A (`msi3g44rb9u` … `msi3huhnhbb`) | 5 | **1 each** |
| B (`msige1braoq` … `msigfrpvvn4`) | 5 | **1 each** |

So **10/10 delivered, exactly once, no duplicate and no loss** - which is the question the check
exists to ask. This is also, incidentally, the strongest evidence yet that WP-PENDING-1's per-page
drain works: a ten-minute backlog is now collected without an abort.

Two things it took to get there, both setup gaps rather than app defects, and both now in the
harness:

- **The radios coming back RESTARTS the app, and a restarted app re-locks the encryption PIN.** The
  whole chat then sits behind the modal, so `openConversation` finds nothing. `notif.mjs` now calls
  `unlock()` (spawning `pin.mjs`, which reads the PIN from `test-accounts.json` and never from
  argv) immediately after `phone.launch()` in both the setup phase and branch 10's restart phase.
- **The conversation list is empty for a while after that restart** - "Aucune discussion" plus
  "Synchronisation des messages…" - so a navigation attempted too early fails for a reason that has
  nothing to do with the check. The messages were all there once the sync completed.

**Still open, and it is the reason this is not a clean PASS:** `shadeHits: [0,0,0,1,0]` and
`reconnectToShadeMs: null`. Only the fourth of five messages ever raised a notification, and none
appeared after reconnecting. The messages arrive; the *notifications* for four of five do not.
Whether that is FCM collapsing a burst (the platform is entitled to) or Canari's own notification
path dropping them is undecided - and it needs a run that reads the phone's log during the
reconnect, not just the shade afterwards. Distinct from NOTIF-9, which passed with one message.

<details><summary>What the first run of NOTIF-10 looked like, and the 19th harness fault</summary>

**The original run had to be discarded.** Five messages sent across a ten-minute
radio blackout; the run reported `counts: [0,0,0,0,0]` on the phone, which reads like a total loss
of five messages and is **not evidence of one**: when the radios came back the app process had
restarted and was sitting on `/posts`, so the final count read the FEED, not the conversation. A
marker cannot appear on a screen that does not show messages. This is the family this page keeps
re-learning - an assertion made against a page that is not displaying the thing under test - and it
means the `counts` field measured nothing at all.

Two observations from the same run ARE real and are the reason to re-run rather than dismiss it:
`shadeHits: [0,0,0,1,0]` - only the fourth of five messages ever raised a notification - and
`reconnectToShadeMs: null`, no notification at all after reconnecting. Whether that is FCM collapsing
a burst to one (which is exactly what the check exists to measure) or something else is undecided.

The re-count that would have settled it also failed: `openDM` from the feed on the phone timed out
after two minutes. So **presence of the five messages on A1 was UNKNOWN**.

**The 19th harness fault, and it is the archetype.** The check *did* navigate to the conversation -
`await ensureChat(a1).catch(() => null)` then
`await openConversation(a1, 'Claire VAN RUYMBEKE').catch(() => null)`. Both swallow their own
failure, so when navigation did not happen the check carried on and counted anyway. That is the rule
this page states in its own header, applied to itself: **an action that cannot prove it took effect
still yields a verdict, and that verdict is fiction.** A restarted process opens on its default route
(`/posts`), not where it was when it died, so there was nothing to find and the check said so in the
language of a catastrophic bug.

Fixed: the failure is now reported rather than swallowed, and the count is gated on a **post-
condition** - the composer must exist on screen, or the check throws instead of producing a verdict.
`{ focus: false }` on the phone client, since focus emulation is for the browsers. The very next run
threw that assertion - `A1 is not in a conversation (http://tauri.localhost/chat)` - which is the
post-condition doing exactly its job, and it is what exposed the PIN modal above.

</details>

**NOTIF-4 found a real bug and cost the 18th harness fault, in that order** - which is only clear in
hindsight, and is exactly why the fault was not allowed to end the investigation.

The check: A1 is killed (swipe from recents), a message arrives and notifies, then W1 reads it, and
A1's notification must disappear. It failed three times. The mechanism it exercises is worth stating
because it explains the bug: cross-device dismissal does **not** need the plaintext. A read receipt
is an ordinary E2E message sent with `silent: true`, and Android infers "the user read this
elsewhere" from two **cleartext** push fields - `silent` and `senderId == self`.

**The harness fault (18th): both browsers report `document.hasFocus() === false`,** because only one
OS window can hold focus and the harness drives two. W1 could therefore never emit a read receipt at
all. `chat.mjs` now enables CDP `Emulation.setFocusEmulationEnabled`, which makes the page report
focused **without** changing `document.visibilityState` - so the TAB phase, which depends on
visibility, keeps its meaning. NOTIF-4 now *asserts* the focus gate instead of assuming it, and waits
6 s rather than 2 s for the debounced receipt to ride the outbox.

**That fault was real and was not the cause.** Run 3 had `hasFocus: true` and still failed. The
logcat showed all three steps: the receipt arrives (`senderName=… silent=true`), the decrypt of it
fails 16 s later, and `cancelConversationNotification` is never reached. In
`CanariFirebaseMessagingService.kt` the dismissal sat **below** the decrypt ladder, behind an early
`return@runWithWakeLock` on `decrypted == null && silent` - so precisely when the receipt could not be
decrypted, the action that never needed the plaintext was skipped. Hoisting the dismissal above
`tryDecrypt` is the whole fix (WP-NOTIF-1).

**iOS was already correct**: `canari_push.mm`'s `if (silent)` branch never tested `decrypted`. The
platforms had diverged only in *where an early return sat* - a divergence the file-by-file parity
audit of v0.12.0 could not have seen, because both files declare the same things.

**Verified on the device, 2026-08-07 00:12** (APK `lastUpdateTime=2026-08-07 00:09:50`):
`shadeBefore: 1 -> shadeAfter: 0`, **dismissed 263 ms** after W1 read it, `w1Focus.hasFocus: true`,
`killedInMs: 77`, notification delivered in 18.05 s. Both browser logs clean.

One `notable` line on W1 is worth recording rather than ignoring: `Ciphertext generation out of
bounds 246 / SecretReuseError`, immediately followed by `[MLS] Message decrypted … ->
addMessageToChat` and `readOnW1: 1`. That is the WP-LOSS-1 classifier taking its **benign** branch on
a genuine double delivery - the frame was recognised by `inboundFrameLedger`, no `LOST frame` was
emitted, and the message was displayed. The loss branch still has no observed firing, which remains
the point rather than a gap.

`[SEND] … queued (pending)` on W2 is the outbox queueing a send; it belongs on the benign list.

### The 15th harness fault: a kill that killed nothing

LIFE-8 first reported FAIL with `pid` identical before, during and after. `am kill` only reclaims a
process the framework considers safe to kill, so a FOREGROUND app survives it silently - the check
measured the ordinary foreground path and called it a lifecycle result. Two fixes, and the second is
the general one: `enter()` now goes HOME first, and the process death is an **assertion**
(`requireDead`) rather than a field printed beside the verdict. `diedAsExpected` is now part of the
verdict expression, because a check whose state was never entered can satisfy every other condition
and still be meaningless.

### An offline device cannot catch up, and the reason is a deadline on the wrong scope (WP-PENDING-1)

`fetchPendingMessages` wraps the **entire multi-page pull** in one `AbortController` with
`FETCH_TIMEOUT = 10_000` (`frontend/src/lib/services/BaseMlsService.ts:522-527`), while
`pullPendingMessagesJson` loops `limit=500` pages until a short page
(`frontend/src/lib/mls-client/mlsDeliveryApi.ts:82-112`). The phone had **5 526 queued rows** = 12
pages, and the abort fired at 10 s every single time:

```
20:10:11.859  [WS] Connected to Chat Gateway        <- network is up
20:10:21.220  [API] <- 200 GET /api/presence        <- network is up
20:10:21.889  [PENDING] Failed to fetch pending messages: TypeError: Failed to fetch
20:10:21.903  Uncaught (in promise) The resource id 1591651946 is invalid.   (x4)
```

Three occurrences, 10.03 s / 10.26 s / 10.30 s after their reconnect - the timeout, not the network.
On Android an aborted Tauri request surfaces as `TypeError: Failed to fetch` plus orphaned
`resource id … is invalid` rejections, which **reads like a network failure and is not one**.

The failure is self-sustaining: nothing is enqueued and nothing is ACKed unless the whole pull
completes, so the backlog never shrinks and every later reconnect fails identically. Proven by
shrinking it - 5 526 -> 95 rows, and the very next reconnect logged
`[PENDING] Fetched 95 pending messages` in **0.6 s**.

It is NOT the database. `EXPLAIN ANALYZE` of the exact query on prod: **8.9 ms**, using the composite
`(recipientId, deviceId)` index, top-N heapsort. The cost is 12 sequential round trips of ~465 KB
each, parsed in a phone WebView, under one 10 s budget.

The remedy is scope, not a bigger number: the deadline belongs to **each page**, and each page should
be ingested and ACKed as it lands, so partial progress is kept. A per-pull deadline can only ever be
right for a backlog small enough not to need one.

**FIXED 2026-08-06.** `pullPendingMessagesJson` now takes `{ pageTimeoutMs, onPage }`: it builds a
fresh `AbortController` per page and hands each page to `onPage` the moment it lands, so nothing is
accumulated and nothing waits on the pull finishing. `fetchPendingMessages` passes
`enqueuePendingRows` (extracted verbatim from its old body) as `onPage`, and its catch reports how
many messages were drained before the failure - `[PENDING] Pending fetch failed after N messages` -
because "the pull failed" and "the pull failed after four pages" describe a stuck device and a
catching-up one. Four tests in `mlsDeliveryApi.pending.test.ts` pin the behaviour, and the third is
the one that would have caught the bug: two pages each taking 900 ms complete under a 1 000 ms
**per-page** budget and would not under a 1 000 ms per-pull one.

Note this is the SAME code on the phone - the Tauri WebView runs the same bundle - so the Android
half needs no separate fix, only a rebuild.

### And the frame is lost even when the pull succeeds (WP-PENDING-2)

With the backlog emptied, LIFE-6 still fails. The clean capture:

```
20:31:13.515  CanariFCM: onMessageReceived ... queuedMessageId=1f3cb134… hasInlineProto=true
20:31:13.515  CanariFCM: App in foreground -> MLS handled by the foreground (WS), skip background processing
20:31:14.112  [PENDING] Fetched 2 pending messages
20:31:14.113  [QUEUE] Processing message group=642f389a… qId=1f3cb134…
20:31:14.333  [QUEUE] messageCallback -> true (group=642f389a…) qId=1f3cb134…
20:31:17.285  [QUEUE] Drain complete
```

The frame is pulled, decrypts, is ACKed and **deleted server-side** (verified: the witness row
`eb45c135-5fa2-413e-bdac-4ba38f21589e` is gone from `queued_message`), and the message is in no
conversation - checked by an accumulating scroll read, not a single `innerText`. No `LOST frame`, no
`SecretReuseError`, no `Ciphertext generation out of bounds`, no duplicate line: the WP-LOSS-1 ledger
does not see this one at all.

Two hypotheses are already dead, do not re-open them:

- **The FCM push did not consume the generation.** The native path logged
  `App in foreground -> ... skip background processing` for both frames.
- **It is not the backlog.** The reproduction above ran with an empty queue.

#### Root cause: a GENERATION gap answered by an EPOCH verdict

The `[MLS]` lines were not the place to look - the phone's native log was. Between
`[QUEUE] Processing` and `messageCallback -> true`:

```
openmls::framing::private_message_in  Ciphertext generation out of bounds 6110
                                      TooDistantInTheFuture
mls_core::messaging  MLS decryption failed: group=642f389a… msg_epoch=1 group_epoch=1
                     err=ValidationError(UnableToDecrypt(SecretTreeError(TooDistantInTheFuture)))
mines_app_lib::commands::mls  [GAP] Sender Ratchet gap - message queued in SQLite
sqlx  INSERT OR IGNORE INTO pending_mls_messages …
[GAP] 642f389a… replayed 0 commit(s), epoch 1->1 (target 1), healed=true
[QUEUE] messageCallback → true
```

**`msg_epoch=1 group_epoch=1`.** The epochs match: this was never an epoch gap. It is a SENDER
RATCHET gap - generation 6110 while this device's ratchet sat thousands of generations behind,
because it had never drained the 5 526-message backlog (WP-PENDING-1, and most of that backlog is
read receipts, which advance the ratchet exactly like text). OpenMLS derives forward only up to
`maximum_forward_distance` and refuses beyond it, so the frame is **cryptographically unrecoverable
for as long as the epoch does not change**.

The chain that turns that into a silent loss:

1. `mls-core` classified any `Process error:` as `SenderRatchetGap`, so `TooDistantInTheFuture`
   landed in the retryable bucket and the frame was written to `pending_mls_messages` - a row that
   can never be retried successfully.
2. `recevoir_message_bytes` returned `GAP_QUEUED:<group>:<error>`, and
   `classifyIncomingDecryptError` matched `GAP_QUEUED` first, so the frontend called it an
   `epoch-gap`.
3. Rung 1 ran `attemptCommitReplay`, which found **no commit to replay** (there was no epoch gap) and
   computed `healed = getEpoch() >= activeEpoch` -> `1 >= 1` -> **true**.
4. `healed` short-circuits the handler: `clearEpochGap`, `return true` - so the queue ACKed it and
   the server DELETED the message. Rung 2, the only thing that could have helped, never fired.

The generalisable fault is step 3, and it is the campaign's recurring shape: **a verdict computed
over one dimension, answering a question asked about another.** `epoch >= activeEpoch` is a true
statement that means nothing when the failure was not about epochs, and "0 commits applied" was the
evidence that should have refused the conclusion.

**FIXED 2026-08-06**, four places:

- `mls-core`: `DecryptErrorKind::GenerationTooFarAhead`, matched **before** the generic
  `Process error:` arm.
- `src-tauri`: that kind is no longer written to `pending_mls_messages` (dead rows) and surfaces the
  error verbatim, exactly as the `SecretReuse` fix did - the shared classifier decides, not the
  native layer.
- `classifyIncomingDecryptError`: `TooDistantInTheFuture` is checked **before** `GAP_QUEUED`, because
  the native wrapper means both markers are present at once.
- `handleKnownGroup`: a new `generation-gap` branch logs a `LOST frame`, then goes straight to
  `forgetGroup` + `requestReAdd`. No threshold and no replay: every later frame from that sender in
  that epoch fails identically, so waiting only loses more of them, and unlike `secret-reuse` the
  re-Welcome is the cure rather than collateral damage - it is the only thing that resets the
  ratchets.
- `attemptCommitReplay` additionally refuses to report `healed` when it applied nothing and was
  already at the target epoch, so any future path reaching it with a non-epoch failure gets a
  truthful answer.

The window that produced it is `SenderRatchetConfiguration::new(2000, 2000)` (`mls-core/src/group.rs`),
so "too far ahead" means **more than 2 000 frames missed from one sender in one epoch** - which only
an undrainable queue reaches, and is why the two work packages are one story.

#### The verification found a third defect: a recovery awaited inside the drain (WP-DRAIN-1)

Re-running LIFE-6 on the rebuilt APK showed the new chain firing exactly as designed:

```
mls_core       MLS decryption failed ... TooDistantInTheFuture   msg_epoch=1 group_epoch=1
mines_app_lib  [GAP] Generation too far ahead - unrecoverable locally, escalating to the frontend
Console        [MLS] LOST frame ... generation too far ahead of our sender ratchet
mls_core       forget_group: 642f389a… forgotten (memory + storage, re-Welcome expected)
Console        [PIPELINE] Out-of-sync for 642f389a… - requestReAdd
```

And then nothing. `requestReAdd` never returned and never logged a line, so:

```
21:25:33  [QUEUE] Drain start (messages=1)      <- never followed by "Drain complete"
21:28:32  [PENDING] Fetched 2 pending messages  <- enqueued, never processed
```

Three later messages were queued server-side for the device, arrived over FCM
(`App in foreground -> MLS handled by the foreground (WS)`), and were never seen again. The user saw
the app stuck on "Synchronisation des messages" with a working socket - which is what a frozen
`isDraining` looks like from the outside.

**The message callback runs inside the drain, and `isDraining` is lowered only once it returns**, so
any await in it that can hang stops every inbound message with no diagnostic. Identical in kind to
WP-HIDDEN-1, reached by a different door - the deliberate gap that work package left open ("any hung
await inside `onDrainEnd` can still stop every inbound message") is the same statement about the
other end of the same drain.

Waiting was never useful: the recovery's result is not read, and a Welcome or an external join lands
long after this frame has been answered. All five recovery call sites inside the drain (known-group
rung 2, the generation gap, the generic error branch, the unknown-group buffer, the Welcome
self-heal) now go through `startRecovery`, which starts the attempt and logs how it settles.

Two instrumentation changes ride with it, because the failure produced NO line at all: `requestReAdd`
now logs its entry, the throttle skip (previously a silent `return`), each network step and its
result; and the drain arms a 60 s watchdog that prints `[QUEUE] STUCK` rather than leaving "still
working" and "stuck forever" indistinguishable.

**VERIFIED ON THE DEVICE 2026-08-06 21:57, and the new logs named the cause:**

```
21:57:33  [QUEUE] Drain start
21:57:33  [PIPELINE] Out-of-sync for 642f389a… - requestReAdd
21:57:33  [READD] 642f389a... attempt starting
21:57:34  [READD] 642f389a... getGroupMeta -> ok
21:57:34  [READD] 642f389a... externalJoin…
21:57:34  [MLS] externalJoin succeeded for 642f389a… (base epoch 1)
21:57:34  [READD] 642f389a... rejoined via external commit (self-service)
21:57:34  [PIPELINE] Recovery attempt finished for 642f389a…
21:57:36  [QUEUE] Drain complete            <- and every later drain completes too
```

The whole recovery takes **one second** off the drain's thread, so it was never hanging on the
network: it was a **DEADLOCK**. `externalJoin` re-acquires the MLS mutex that the drain holds until
the callback returns. The codebase already knew - `DeferredRecovery` in this very file exists
because "the recovery seams re-acquire the same non-reentrant mutex", and the Welcome path defers
them for exactly that reason. The known-group path awaited one inline.

And the conversation HEALS: three fresh messages after the rejoin arrived in 2.9 s / 1.5 s / 4.1 s,
one copy each. That closes WP-PENDING-2's owed verification as well - the frame that triggers the
escalation is unrecoverable by construction, and everything after it is normal.

The LIFE-6 run itself still reports FAIL, correctly: the message sent while the radios were down was
encrypted at a generation this device can never reach, so it is lost. **Re-run LIFE-6 from here** -
the group is now rejoined at a fresh epoch, so the next run measures the ordinary offline path
instead of a two-thousand-generation debt that no longer exists.

#### How big the queue gets - and it was NOT by design (WP-GHOST-1)

Prod, 2026-08-06: **98 210 rows, 62 devices, 150 MB**, oldest 2026-06-11. This section first said
that was the deliberate 90-day retention and carried no work package. **That was wrong**, and the
measurement that refuted it is below. Retention is real and it IS the size of WP-PENDING-1's
exposure - an ordinary device coming back to tens of thousands of rows is exactly the case the
all-or-nothing pull could never serve - but it is not why the table was 150 MB.

Grouping by the FULL `deviceId` rather than a prefix is what showed it: **97 353 of the 98 210 rows
(99.1 %) belonged to nine device ids that no longer exist**, all of them still `status = 'active'`
in `dm_device_group_memberships`. Claire had **five** such ids each holding exactly 10 810 rows -
every message sent to her was encrypted and stored five times over. Every other device on the
platform held at most 84 rows.

**Deleting those devices through the product's own UI** (`/settings` -> "Gérer" -> the trash icon,
which is `DELETE /api/mls/devices/:userId/:deviceId` -> `purgeDeviceFootprint`) took the table from
**98 210 rows to 984** and the memberships with it. So the delete PATH is clean; nothing ever calls
it. That is the defect.

##### Why a dead device is never collected

Three mechanisms lock together, and the third resets the clock the first two depend on:

1. `cleanupStaleDevices` ([app.controller.ts:316](../../apps/chat-delivery-service/src/app.controller.ts#L316))
   is the only thing that purges, and it **vetoes any device holding an `active` membership**.
2. `detectStaleDevices` ([app.controller.ts:229](../../apps/chat-delivery-service/src/app.controller.ts#L229))
   is the only thing that clears `active`, and it pre-filters on `updatedAt < now - 90 days`. Its own
   comment defends the filter: "a row touched within the window is certainly not stale".
3. But `updatedAt` is a TypeORM `@UpdateDateColumn` bumped by **other people's clients**, not by the
   device's liveness: `activateDeviceMembership`'s upsert carries no `skipUpdateIfNoValuesChanged`,
   `sendWelcome`'s is fanned out in parallel by `deliverWelcomes`, and `processPendingInvitations`
   re-marks a device `active` from its `ALREADY_MEMBER` branch - a peer may vouch for another user's
   device by design. All nine ghosts carry `updatedAt` within four seconds of each other (05:05:2x),
   the signature of exactly such a burst.

So a demotion is undone by the next peer sync, the veto holds forever, and the fan-out
([messaging.service.ts:471-509](../../apps/chat-delivery-service/src/services/messaging.service.ts#L471))
mints a row for every `active` membership **with no key-package check at all** - while the
invitation path does validate key packages and `sendWelcome` hard-fails without one. That asymmetry
is the whole bug: a device good enough to be messaged forever is not good enough to be invited.

**The generalisable rule: a liveness clock must be written by the thing whose liveness it measures.**
`updatedAt` answers "when was this row last written", and it was asked "when was this device last
seen". Same shape as WP-PENDING-2, where an epoch verdict answered a generation question.

##### The root cause, found the same night: a REVOKED device writes its own membership back

Everything above explains why a ghost is never *collected*. It does not explain how one is *created*,
and the preserved reproduction answered that on its own. `tauri-d82cd226…-ms8xyqkk-2rwh` is not a
device that merely vanished:

- it is in `revoked_device`, **revoked 2026-07-31 13:52:48**;
- it holds **zero** key packages, and can never regain one - `devices.controller.ts` refuses
  registration for a revoked id;
- and it nevertheless carries membership rows written **2026-08-04 18:03:22**, four days *after* the
  revocation.

Something wrote a routing membership for a device the platform had already disowned. That something
is `POST /api/mls/invitations/status`
([invitations.controller.ts](../../apps/chat-delivery-service/src/controllers/invitations.controller.ts)):
`updateInvitationStatus` upserts a `DeviceGroupMembership` from nothing but the ids in the body,
checking neither the denylist nor the key package - while `getPendingInvitations`, **the endpoint
directly beside it in the same file**, checks both before offering a device as an invite candidate.
One endpoint's admission rule was simply never applied to its neighbour.

The rest follows mechanically. A revoked device cannot re-register, so it never regains a key
package; with no key package it is invisible to `getUserDevices` (so no human can see it to delete
it) and invisible to `cleanupStaleDevices` (which enumerates *from* `key_package`); and
`detectStaleDevices` never selects it because of the `updatedAt` pre-filter above. The device is
simultaneously unreachable by every collector and freely writable by any peer. Corroborating the
"peer sync" mechanism: user `9855dfaf…` holds ~8 devices whose `last_touch` is identical to the
tenth of a second (`2026-08-03 09:03:07.x`) - one client's sync pass, vouching for eight devices at
once.

##### The fix, 2026-08-06 (`5335a71f`)

One predicate, `MessagingService.deviceAddressability(userId, deviceId)`, is now the single
definition of *may this device be routed to*: **not on the revocation denylist, and holding a static
`KeyPackage`**. It is applied at all three places that could mint or honour a routing membership:

| Seam | Behaviour now |
| --- | --- |
| `updateInvitationStatus` (`status: 'active'`) | `400`, logged `[INVITATION_STATUS] REFUSED … reason=…`. Demotion to `pending` stays allowed - it is a step *towards* cleanup. |
| `activateDeviceMembership` (commit fan-out, background push) | returns without writing, logged `[MEMBERSHIP_ACTIVE] REFUSED …`. The commit itself is still `accepted: true` - only the routing row is refused. |
| the send fan-out's fallback path (which seeds `group:members:<groupId>`) | ghosts filtered out, logged `[SEND][…] SKIPPED_NO_KEY_PACKAGE …`. |

Collection was widened to match creation: `detectStaleDevices` no longer pre-filters on `updatedAt`
(the premise that "a row touched within the window is certainly not stale" is exactly what was
false - `lastUpdate` is still *logged*, as evidence, never as a criterion), and `cleanupStaleDevices`
now enumerates devices holding memberships with **no** `key_package` row and purges them, so the
ghosts already on disk are collected rather than only being prevented in future. Because
`setInterval` never fires at t=0 - and this service redeploys far more often than daily, so a 24 h
job had in practice never run at all - a boot sweep runs all nine GC jobs once, 60 s after start.

Two refusal tests pin the contract in `messaging.commit-log.spec.ts`; the frontend caller
(`frontend/src/lib/utils/chat/actions.ts`) already swallows the response, so the new `400` is inert
there.

**The rule, and it is the same one twice: a device good enough to be MESSAGED must be at least as
valid as one good enough to be INVITED.** Two endpoints in one file disagreed about what a valid
device is, and the gap between them is where 97 353 rows lived.

##### What the first production run of the sweep found - including a fault in the sweep itself

Deployed 2026-08-07 00:16. The boot sweep fired 60 s later and did exactly half its job:

```
[CRON] initial sweep: running every GC job once
[CRON] Stale device reset: device=tauri-…-ms8xyqkk-2rwh group=66e1b07e… (lastUpdate=2026-08-06T22:17:51Z, no KeyPackage since 2026-05-08T22:17:51Z)
[CRON] Stale device reset: device=tauri-…-ms8xyqkk-2rwh group=bee389a8…
[CRON] Stale device reset: device=tauri-…-ms8xyqkk-2rwh group=4f87267a…
[CRON] initial sweep: cleanupStaleDevices failed
[CRON] initial sweep: done
```

The three resets are the proof that removing the `updatedAt` pre-filter was the right call: that
device's `lastUpdate` is **the current instant**, so the old query could never have selected it, and
the reason it is stale is on the same line - `no KeyPackage since`.

Then `cleanupStaleDevices` threw `syntax error at or near "DISTINCT"` (Postgres `42601`).
**TypeORM does not preserve the order selects are declared in**, so `.select('DISTINCT dgm.userId',
…).addSelect('dgm.deviceId', …)` emits `SELECT "deviceId" AS …, DISTINCT "userId" AS …`. The
single-column builders beside it use the same spelling and work only because they have nothing to
reorder. `.distinct(true)` is the fix (`eed39f51`).

Two things generalise, and they are the useful part:

- **A mocked repository never parses SQL.** All 106 unit tests pass over this query; nothing short of
  a real Postgres could have rejected it. Where a test cannot reach, the deploy log is the test - so
  read it, rather than reading the CD's green tick.
- **The sweep caught per job and logged the failure loudly**, which is the only reason this was a
  five-minute find rather than a GC that silently did nothing for months. A batch of maintenance jobs
  must never share one try/catch: one broken job would then hide the other eight, and all nine would
  report the same silence they report when there is nothing to do.

##### VERIFIED, 2026-08-07 00:32 - the reproduction was collected by the fix

`eed39f51` deployed, and the boot sweep 60 s later did the whole job:

```
[CRON] initial sweep: running every GC job once
[CRON] cleanupStaleDevices: purged device=d82cd226…:tauri-…-ms8xyqkk-2rwh groups=3 queued=124
[CRON] cleanupStaleDevices: purged 1 stale device(s) (1 of them with no KeyPackage at all)
[CRON] initial sweep: done
```

The device that had been invisible to `getUserDevices`, vetoed out of `cleanupStaleDevices` and
never selected by `detectStaleDevices` was collected automatically, taking its 3 membership rows and
124 queued frames with it. Confirmed in the database immediately afterwards: `ghost_memberships 0`,
`ghost_queued 0`, and - the figure that closes the class rather than the instance -
**`orphan_rows_left 0` across the entire platform**. `queued_message` is 1 842 rows.

That is the whole ladder demonstrated end to end on production: the creation seams refuse a device
that is revoked or has no key package, the detector no longer trusts a clock other people write, and
the collector reaches a device that no longer has a key package to be enumerated from.

**And it holds.** Six hours later, with the hourly GC having run repeatedly: `orphan_rows 0` still -
no new ghost has been created - `queued_message` at 1 860 rows across 55 devices with the busiest
holding **507** (the nine ghosts held 10 810 *each*), and `auth_db` steady at 29 MB. Zero
`cleanupStaleDevices: purged` lines in that window, which is the correct output when there is
nothing left to collect, and zero `REFUSED` / `SKIPPED_NO_KEY_PACKAGE` lines, meaning nothing has
tried to resurrect a dead device since. A one-shot purge would have shown the same table at
midnight; only the second measurement distinguishes a fix from a cleanup.

##### The 16th and 17th harness faults, both from this hour

- **A run whose progress goes through `| tail -N` is unobservable.** `tail` buffers until EOF, so a
  check that logs every stage printed nothing at all and looked like a hang; two NOTIF runs were
  killed on that misreading. Redirect to a file and read the file.
- **The device panel opens EMPTY and fills in.** Read 2 s after opening, it reported `deletable: 0`
  for an account holding five deletable devices - "Synchronisation des appareils…" was still on
  screen. Exactly the family this page keeps re-learning: an assertion made before the thing under
  test exists yields a confident wrong answer. `purge-devices.mjs` now waits for the loading label to
  go AND for the count line to appear, and every deletion asserts the row count FELL - the client
  turns a non-2xx into an in-panel error string and leaves the row in place, so a swallowed 4xx would
  otherwise read as a success.

##### What survived the purge, deliberately

One orphan remains: `tauri-…-ms8xyqkk-2rwh`, 3 memberships, **no key package at all**. It was kept as
the live reproduction, and it is what identified the root cause above - it turned out not to be a
device that merely vanished but a **revoked** one that wrote itself back. Across the platform it is
the only one (`54` devices hold memberships, `230` hold key packages, exactly `1` holds memberships
without). Once `5335a71f` is deployed it is also the verification: the boot sweep should purge its
three memberships, and any further `invitations/status` for it must answer `400`.

What happens after the escalation is worth knowing before reading a log: the first bad frame forgets
the group, so every later queued frame takes the `!inGroup` path, is buffered and **not** ACKed
(stays server-side). Once the re-add lands, those old-epoch frames fail as `wrong-epoch`, which does
ACK - so the queue drains rather than growing, but only after the rejoin.

**Still open, deliberately:** `map_decrypt_outcome` (`src-tauri/src/state.rs`, the BATCH path used by
history replay) still answers `ok: true, data: None` for `SecretReuse` - the same "the native layer
threw the diagnosis away" that WP-LOSS-1 fixed in the realtime path. It was left alone because
changing it moves history replay onto the desync signal, which needs its own measurement.

### Two method corrections this phase cost

- **`countMessage` reads a screenful of a VIRTUALISED list**, so its answer depends on the scroll
  position - the same trap that once made reconciliation report two live messages as lost. A marker
  that "appeared after a restart" appeared because the view opens at the bottom. Every presence
  claim here comes from `probe9.mjs`, which accumulates the text at every scroll position.
- **Postgres stores UTC and the host is Europe/Paris.** Reading `max(createdAt) = 18:09:47` as
  "nothing has been queued for two hours" was wrong by exactly the offset: 18:09:47 UTC **is** the
  20:09:47 send under investigation. The host clock is correct and must not be "fixed" - UTC in the
  database is the right setting, and changing it would move the crons and break log correlation.

## The retransmission storm, 2026-08-07: a repair that fed itself

Found because the user asked an ordinary question - *"there are message-sync banners, I don't know
if that's normal"* - about something a check would never have flagged. It was normal, and it was the
symptom of a defect that no check in this campaign was looking for.

### The banner was honest, which is what made it worth following

`isSyncing = session.isMessagingInitializing || messaging.isMessageCatchupActive`, and the second is
a depth counter raised by every drain that has more than one frame pending. On the phone it was up
on 20 consecutive samples over 30 s; the two browsers never showed it in the same window (182 drains
on W2, none of them long enough to matter). The phone's queue on the server was **4 921 rows**, and
the banner came down by itself the instant that queue reached zero. Nothing was stuck. The phone
really had been synchronising, for about eighteen minutes.

The interesting question was therefore never the banner. It was: **who queued 4 921 frames into one
DM in thirteen minutes, with nobody typing?**

| Measurement | Value |
| --- | --- |
| Window | 12:59:03 -> 13:12:21 CEST, then it stopped on its own |
| Rate | ~430 frames/min, flat - a steady state, not a spike |
| Senders | three web devices (one of each account, plus an older tab of one) |
| What the phone did with them | decrypted every one, answered each, ACKed at the end of each drain |
| Residue afterwards | none - the queue drained to 0, and both browsers' outboxes were empty |

### The loop

The trigger is the ordinary WP-LOSS-1 detection: a device that cannot decrypt a frame emits
`decrypt_failed`, asking peers to resend the last 120 s, because - and this is the crux - **it cannot
name what it is missing**. The frame never decrypted, so its id was never seen. Peers answer from
`recentSends`, an in-memory ring of up to 25 payloads with a five-minute retention. That repair is
meant to expire: five minutes of quiet and there is nothing left to replay.

It never expired. Each replay went out through `enqueueControlEvent`, which mints a fresh
`crypto.randomUUID()` and `sentAt: now`, and the flusher then called `noteSentFrame` on it like any
other send. Both bounds of the ring fell at once:

- **the fresh timestamp** pushed the five-minute expiry out indefinitely - the ring never aged;
- **the fresh id** meant the dedup key no longer matched the payload it should have replaced, so the
  ring *accumulated* copies instead of replacing them, up to its 25-entry cap.

The ring stopped being a decaying buffer of recent sends and became a permanent playlist, replayed
in full on every signal. The arithmetic closes: the limiter allows one signal per group per device
per 30 s, so three devices give 6 signals/min; each is answered by the others with ~25 payloads, and
each answer is fanned out to every device in the group - **~430 frames/min into the phone**, which is
what was measured. It ended when a tab reloaded, because the ring is in memory. Nothing had repaired
it.

**The fix** (`9a0b199a`): a replay carries `isRetransmission`, and the flusher does not retain it.
A replay is not a send. Two tests pin the halves separately - the flag being set, and the flusher
honouring it - because a flag nobody reads and a reader with nothing flagged are each green alone and
useless together. The positive control caught a fixture bug on the way: the existing control fixture
uses `sentAt: 50`, which the five-minute retention discards, so both assertions read an empty ring
and the negative one passed for the wrong reason.

### And a second defect, which would have made this invisible

`BaseMlsService.endBulkIngest` awaited its observers in one bare loop, although the code registering
them says they are "independent subscribers". The encrypted-state persister is registered first and
rethrows when a checkpoint fails - so any failed disk write would have skipped the UI observer
entirely. `messageCatchupDepth` never comes back down (the banner stays up for the whole session)
and `bulkIngestActive` stays raised, so every later inbound message is buffered instead of rendered,
then discarded by the next drain. That is message loss, not a stuck banner. Now per-observer, with
every failure logged - the same rule the maintenance jobs already follow.

### What this says about the remedy itself

The storm is fixed, but the shape that produced it is not. Three properties of `decrypt_failed` did
the damage, and none of them is an accident:

- **It is addressed by TIME, not identity**, because the receiver genuinely cannot name the frame.
  So the answer must be a window, and a window is a broadcast.
- **Every peer answers**, so the cost of one signal scales with the group.
- **It reads an in-memory ring**, so the repair is a race against a reload - which is why the log
  line the phone emitted thousands of times was *"nothing sent in the last 120s is still retained -
  it cannot be recovered"*. That case is not rare; it is the normal outcome once the sender has
  reloaded.

A manifest diff has none of the three. The receiver sends what it HAS; the peer computes what is
missing and holds its id; the exchange reads the durable store; and the responder is elected
server-side. **That is WP-HIST-3**, whose algorithm was already built and tested inside the QR sync
engine (since deleted) - only the transport was absent. The conclusion recorded on 2026-08-07 is to build it rather than to keep
hardening the window-based repair, with a give-up counter as the escalation point from a narrow
immediate resend to the diff.

One measurement worth keeping for that work: **the five-minute retention is already dead weight**.
`DESYNC_RETRANSMIT_WINDOW_MS` is 120 s and `retransmitRecentSends` clamps the replay to what is
asked, so no Canari client can ever reach beyond two minutes. The extra three minutes shorten no
replay - they only hold plaintext protos in memory longer than anything can use them. Retention
should be derived from the request window plus a round-trip margin, not an independent constant.
