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
| LIFE-3 | Killed | `am force-stop fr.emse.canari` |
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
| **WP-KBD-1** | A1 0.13.0, prod 2026-08-06 | **FAIL -> WP-KBD-1** | Tap the composer, HOME, return: the shell is pinned to the visual viewport but starts below the status-bar inset, so it overflows by that inset and the composer sits behind the keyboard. Numbers in [mobile](frontend/mobile.md#the-soft-keyboard-and-the-app-shell-wp-kbd-1-open). |
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

**What the gate does not cover, and why it does not need to:** channel messages bypass the outbox
entirely, but they are not MLS - `sendEncryptedChannelMessage` encrypts under the versioned channel
key with a fresh nonce, so two tabs sending at once is ordinary AEAD, not a shared ratchet. What
does remain uncovered is any FUTURE write path that reaches `mlsService` without going through the
queue: nothing type-checks that. The structural answer to that whole class is one MLS client in a
SharedWorker - noted in `CLAUDE.md`, not scheduled.

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
