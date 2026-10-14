# Community opening on the Mi 9T, read with a real console - 2026-10-13

The question: why opening a community and walking its salons feels slow on Android. Measured on
the Mi 9T with the DEBUG build of `fr.emse.canari` (client `1.2.6`) pointed at PRODUCTION, signed in
with the user's own account, read-only: the community "Mines'ifestations" (salons `infos`,
`general`, `banderoles`, `tract`, `general` again), then one DM, then back to the dashboard. The
WebView console was captured over CDP (`webview_devtools_remote_<pid>` forwarded by `adb`, only
`Runtime.enable` / `Log.enable`), logcat in parallel, and a second pass ran the same walk under
`Profiler.start` (0.5 ms sampling) - the profile is what turns the log's silences into causes.

**Two caveats decide how far the numbers travel.**

- **The debug build is ~10x slower than the store build**, so durations below are only meaningful
  against each other; counts and sequences are what transfer.
- **The device had been signed in two minutes earlier** (`11:57:48`, `[MLS][Tauri] group caches
  rebuilt from the native manager - 0 group(s)`), so the whole walk ran on top of a device rejoining
  every conversation (`[READD] ... externalJoin`, 63 joins in the first capture, still running 12
  minutes after sign-in). This is the FIRST-SIGN-IN case. The steady-state case is owed a capture
  once the rejoin is finished (see the end).

## What each open looked like

Device clock = workstation - ~1.8 s (pinned by `[appLink] In-app navigation -> /chat` against the
recorded tap). "Frozen" = time between the tap and the route's first line (`[API] -> POST
/api/channels/<id>/read` or `GET .../members`), during which the console printed NOTHING.

| Open                 | Frozen after tap | First paint (screenshot) | Route traffic                                   | Notes                                                                                 |
| -------------------- | ---------------- | ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| community (sidebar)  | -                | < 1 s                    | none                                            | channel list is local                                                                |
| `infos`              | ~0.4 s           | < 2 s                    | `read`, `members`, `pins`, `users/batch`        | one media row: 3 avatar 404s                                                          |
| `general` (1st)      | **~4.0 s**       | between 3 s and 8 s      | `read` (**5094 ms**, of which ~1.1 s network), `members`, `pins`, `users/batch` | **25 avatar 404s, 47 avatar mirrors**; a 5771 ms checkpoint spans the freeze          |
| `banderoles`         | ~0.3 s           | < 2 s                    | `read`, `members`, `pins`, `link-preview` x2    | **info panel opened by itself** (`bubble tap on 0c40ac8f: single, info panel`)        |
| `tract`              | ~1.2 s           | < 2 s                    | `read` (2259 ms), `members`, `pins`             | **info panel opened by itself** (`bubble tap on f2016215`); 2977 ms checkpoint spans it |
| `general` (2nd)      | **~3.4 s**       | 2-3 s                    | `members`, `pins`                               | 46 avatar mirrors AGAIN; a 4578 ms checkpoint spans the freeze                        |
| DM                   | none visible     | < 1 s                    | none                                            | conversation is local                                                                 |

No `[SELECT]` and no `[HISTORY]` fetch is attached to any open: every salon renders from the local
store. **Nothing on the open path itself is slow; what is slow is the thread it runs on.** The three
long freezes coincide, each to the second, with the only three checkpoints above 2.5 s in the whole
capture (`12:00:43.618 5771 ms`, `12:02:02.640 2977 ms`, `12:03:16.856 4578 ms`), against a median
of ~1.4 s.

## Finding 1 - a synchronous MLS command freezes the WebView for the rest of a checkpoint

The profile of the second walk (38.9 s) spends **21.8 s inside `sendIpcMessage`** - the Tauri IPC
send - in contiguous blocks of 1.6 to 3.2 s, each one a single call:

| Start  | Blocked  | JS caller                                    | Native command                  |
| ------ | -------- | -------------------------------------------- | ------------------------------- |
| 2.16 s | 1601 ms  | `joinByExternalCommit`                       | external join                   |
| 3.87 s | 3167 ms  | `encryptForSend`                             | `envoyer_message_bytes`         |
| 7.20 s | 3116 ms  | `mergePendingCommit`                         | `confirmer_commit`              |
| 18.16 s| 2860 ms  | `isGroupActive` (history reconcile ask)      | `groupe_actif`                  |
| 25.51 s| 3195 ms  | `readEpochIntoCache` (`refreshEpochCache`)   | `obtenir_epoch`                 |
| 32.50 s| 3145 ms  | `isGroupActive`                              | `groupe_actif`                  |
| 36.08 s| 2841 ms  | `isGroupActive`                              | `groupe_actif`                  |

while `persistState` (the checkpoint itself, `sauvegarder_mls_et_persister`) costs the JS thread
**168 ms over eight calls**: it is `async` and returns at once.

The mechanism, read from `src-tauri/src/commands/mls.rs` at `main` `9462d34d9`:

- `sauvegarder_mls_et_persister` (`:208`) takes `mls_manager.lock()` inside `spawn_blocking` and
  holds it across export + seal + file write - [performance audit finding 12](performance-audit-2026-10-12.md#ranked-findings-cost-x-frequency),
  which named the contention and had not measured it on a phone.
- `groupe_actif` (`:495`), `obtenir_epoch` (`:510`), `envoyer_message_bytes` (`:580`),
  `confirmer_commit` (`:687`) are plain `fn` commands taking the same lock. **On Android a sync
  command runs inside the WebView's JavaScript bridge call, so waiting for the lock blocks the JS
  thread itself**: no event, no render, no `await` resumes until the checkpoint ends.

So the cost of a checkpoint is not paid by the next MLS operation, as finding 12 assumed - it is
paid by the WHOLE UI, whenever any sync command lands while one is in flight. `isGroupActive` alone
froze the app for 8.8 s of 38.9 s, called by the history reconcile ask (`utils/chat/historyReconcile.ts:511`)
from the `[READD]` path and from each `[HISTORY_COVERAGE]` answer.

The log shows the same thing without a profiler: at the first `general` open the last line before
the tap is `12:00:39.304 [QUEUE] Drain complete`, the next is `12:00:43.271 [API] -> POST
/api/channels/feca872d.../read`, and that request reports `(5094ms)` although `members` and `pins`,
issued 0.1 s later, answered in 1.15 s: its clock started at the tap and the `log` line could not run
for four seconds.

**What to fix, in order.** (a) Release the manager lock before the seal and the write - the export is
the only step that needs the state (3.8 ms at 80 groups natively, per the audit), the seal and the
file write work on a copy. (b) Make the commands the UI path calls (`groupe_actif`, `obtenir_epoch`)
`async`, so a wait parks a Rust task instead of the JavaScript thread. (a) is the fix; (b) alone
would still serialise them behind a 1-3 s checkpoint, just without freezing the screen.

## Finding 2 - after a sign-in, the checkpoint runs 93 % of the time, and each one costs more

In the first capture (11:57:58 to 12:05:10): **247 checkpoints, 369 s of cumulative
`checkpoint persisted` time in 432 s** - ~56 s of every minute from 12:00 on. The duration grows with
the state: `8 ms` (0 groups) -> `778 ms` -> `1414 ms` -> `1740 ms` -> `2016 ms` at the 63rd join,
the whole-state write of [finding 2 of the audit](performance-audit-2026-10-12.md#finding-2-and-3-read-together---the-checkpoint-question-the-backlog-owed)
paid once per join and then once per drain of the device's OWN history exchange that follows it.

Per rejoined group the sequence is always the same (~4 checkpoints):

```
[READD] <g> attempt starting -> getGroupMeta -> ok -> "serving ourselves" -> externalJoin...
[MLS] Encrypted state checkpoint persisted. (~1.4 s)            <- the join
[MLS] externalJoin succeeded for <g> (base epoch N ...)
[HISTORY_STATE] Sent for <g> - 00000000..., from 2021-10-14T00:00:00.000Z
[QUEUE] Drain start ... messages=1 -> history_digest_request / history_bundle / history_coverage
[MLS] Bulk ingest done - flushing an encrypted checkpoint if needed.   <- x2-3, one per drain
[HISTORY_COVERAGE] <me>:web-... covers <g> only from 2026-07-15 - 1735 d short of what we asked
```

Rejoins run one at a time at ~7 per minute, so a heavy account spends well over ten minutes (debug)
with the UI exposed to finding 1 on every sync command. The cure is finding 1 for the freeze and the
audit's checkpoint levers (faster seal, no checkpoint for a receive-only drain, per-group storage)
for the duty cycle; batching the history exchange of a rejoin into one drain would remove two of the
four checkpoints per group.

**Found while reading this storm (2026-10-14)**: a `flush` made during a running checkpoint was handed
that checkpoint, so `externalJoin` - which awaits its checkpoint so a reload cannot rejoin and fork -
was told its join was durable when it was not, for most joins of a storm like this one. Fixed:
[mls-desync-prevention](../protocols/mls-desync-prevention.md#the-checkpoint-a-caller-awaits-is-the-one-that-exported-after-its-change-2026-10-14).

## Finding 3 - every message bubble resolves its readers' names, visible or not, and re-runs itself

`components/messages/MessageInfoTooltip.svelte:39-55` is mounted by EVERY bubble
(`MessageBubble.svelte:1043`) and its `$effect` runs whether `visible` is true or not. It reads
`resolvedReadByNames` and writes it (`{ ...resolvedReadByNames, [userId]: resolved }`), so each
resolved name re-runs the effect, which iterates all readers again and calls
`resolveUserDisplayName` for each of them again - O(readers^2) per bubble, for salons whose messages
are read by 60-70 people. In the profile that effect is the single largest piece of JavaScript of
the app's own: **2.4 s of CPU** (1.4 s self) inside the Svelte flush, 2.1 s of it during the
`general` open. Fix: do nothing until the panel is opened (`if (!visible) return`), and resolve the
names with `untrack` on the map, written once per batch.

## Finding 4 - opening a salon as an admin taps the message under the finger

Two of the five salon opens ended with the reader panel open over a message nobody touched, and the
log says which tap did it: `12:01:33.502 [MESSAGE] bubble tap on 0c40ac8f: single, info panel`
(`banderoles`) and `12:02:03.003 [MESSAGE] bubble tap on f2016215: single, info panel` (`tract`),
~1 s after the tap on the salon row, with no other touch.

The salon rows live in a `svelte-dnd-action` zone with `delayTouchStart: 350` when the viewer may
reorder them (`components/sidebar/Sidebar.svelte:713`). With a touch delay the library does not
`preventDefault` the `touchstart`, and on a short `touchend` it dispatches its OWN `click` on the row
(`node_modules/svelte-dnd-action/src/pointerAction.js`, `handleFalseAlarm`: "dragging initiated by
touch events prevents onclick from initially firing" - untrue once the delay is set). The row opens
the salon on that synthetic click; the browser's own compatibility `click` follows at the same
coordinates and is hit-tested against the salon that is now mounted. A bubble under the finger takes
it. Only admins (`canReorderChannels`) and only where a bubble lands under the finger, which is why
`infos` and `general` did not show it.

Fix: swallow the native `click` that follows the library's synthetic one on the row (or open the
salon from the library's click only), and pin it with a test that dispatches `touchstart` +
`touchend` + `click` and counts activations.

## Finding 5 - every salon open re-mirrors every face to the notification cache

`utils/userAvatarCache.ts:90` hands each loaded avatar to `mirrorAvatarToNative`, which converts the
bytes with `Array.from(new Uint8Array(...))` and sends them as a JSON number array over IPC
(`utils/avatarMirror.ts:28-29`). "Once per load" is once per salon open in practice, because the
blob pool releases a face when its last mount goes: **170 mirrors for 62 distinct users** in the
first capture, 47 then 46 for the two `general` opens. Fix: remember which user ids were mirrored
this session (or which byte length/etag), and skip the rest.

## Finding 6 - noise met on the way

- **37 `Failed to load resource: 404`** on `/api/users/<id>/avatar`, 25 of them in the first
  `general` open, each with `[AvatarCache] 404 ... absent for the rest of the session`. The
  request is how the client learns a member has no picture; `users/batch`, which it already called,
  could carry that fact (durable rule: never learn by failing what a fact could have told you).
- **496 `[GRAINE] v2 endorsement of session ... verified ... from the tree`** debug lines, the
  largest tag of the capture.
- **`[HISTORY_COVERAGE] ... 1735 d short of what we asked`** x49: the new device asks every rejoined
  group for history from `2021-10-14` and the account's own web device answers that it covers from
  `2026-07-15`; each answer re-enters the ask (`lf` -> `of`, i.e. one more `groupe_actif`) before
  `every reachable member (1) has stated its coverage - nothing more to ask` closes it.
- Expected and not a defect here: `[GRAINE] REFUSED 4 / 14 v1 seed(s)` (v1 seeds are refused since
  G2-5) and `[CHANNEL] 5 message(s) of 61d765e1 are unreadable` that follow from it.

## What this did not measure

- **The store build.** Divide the durations by ~10; the freezes are then 150-400 ms each, which is
  still a dropped tap during a rejoin, and finding 1 holds on any checkpoint, not only after a
  sign-in.
- **The steady state.** The rejoin had not finished when the walk ended. The same walk owes a second
  capture on this device once `[READD]` stops, to separate "slow because rejoining" from "slow
  always".
- **iOS.** The lock is the same; whether a sync command blocks WKWebView's JavaScript the way the
  Android bridge does was not checked.

## How it was measured

Capture: forward `localabstract:webview_devtools_remote_<pid>` with `adb -s <serial> forward`, open
the page target's WebSocket, send `Runtime.enable` and `Log.enable` only, and run `adb logcat` in
parallel. Profile: the same socket, `Profiler.enable` / `setSamplingInterval 500` / `start`, the taps
sent with `adb shell input tap`, `Profiler.stop`; the blocks above are runs of consecutive samples
whose stack contains `sendIpcMessage`, labelled by the first named frame below it. Minified frames
were named by `Debugger.getScriptSource` on the same socket. Raw captures stay off the repository
(they hold a real account's conversations).
