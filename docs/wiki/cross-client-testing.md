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
| NOTIF-7 | Notification tap -> deep link into the conversation | check H - correct conversation opens (`notifNav`, not a `/c/<id>` route) |
| NOTIF-8 | Doze + message | Delivered (high priority) or delivered on wake - record which |
| NOTIF-9 | Two devices of jolan (W1 open, A1 killed) | Exactly one notification surface behaves; no duplicate for the same message |
| NOTIF-10 | Airplane mode for 10 min, 5 messages sent, then reconnect | All 5 arrive; no collapse into one, or an explicitly correct summary |

NOTIF-2/3 double as the check that a **silent commit push** does not leave the next message
permanently unreadable.

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
| **Silent loss** | web, prod 2026-08-06 | **FAIL -> WP-LOSS-1** | Two DMs accepted by the server (`POST /api/mls/send -> 201`), never rendered by the peer, still absent after a reload. See below. |

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

This has a direct consequence for the lifecycle checks: **a backgrounded tab must be produced by
focusing another TAB in the same window**, never by covering the window - the flags now make an
occluded window report `visible`, and covering it would no longer emulate anything.

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
