# Cross-client test harness

The rig used to drive **three real Canari clients at once** against a live deployment: two desktop
Chrome profiles and an Android device. It exists because a whole class of Canari bug is invisible to
a unit test and to a single client - a message that the sender shows as delivered and the receiver
never stores, a tab that stops receiving while looking healthy, a notification that is not dismissed
on the other device. Every defect it found is written up in
[cross-client-testing](../../docs/wiki/cross-client-testing.md); this file is about the rig.

It is **not** a CI suite and must never become one. It drives production with real accounts, it needs
a phone plugged in, and several of its checks take minutes. It is an audit instrument: pick it up
when you need to know what actually happens across clients, not on every commit.

## What it drives

| Client | What it is                       | Reached by                                   |
| ------ | -------------------------------- | -------------------------------------------- |
| **W1** | Desktop Chrome, account A        | CDP on `localhost:9224`                       |
| **W2** | Desktop Chrome, account B        | CDP on `localhost:9223`                       |
| **A1** | The Tauri WebView on the phone   | CDP on `localhost:9222` via `adb forward`      |

One driver (`cdp.mjs`) speaks to all three - the WebView is a Chrome target like any other. `a1.py`
is only for surfaces the WebView cannot reach (the notification shade, the system PIN, the launcher).

> **The working copy is `../canari-harness`, a sibling of this repository** - not a scratchpad, which
> is scoped to a single session and would strand the instrument. `chrome-w1` and `chrome-w2` in it
> ARE the two test devices: their profile directory holds the MLS identity, the history and the
> login, so deleting one costs a re-enrolment and the 2FA that only a human can answer. What is in
> THIS directory is the archived, anonymised copy.

## Getting started

1. **Node 24+** (a global `WebSocket` is assumed - there is no Playwright or Puppeteer here),
   `adb` on `PATH`, and Chrome installed.
2. `cp test-accounts.example.json test-accounts.json` and fill it in. It is gitignored.
   **No credential is ever a command-line argument**: `login.mjs` and `pin.mjs` read this file
   themselves, so nothing sensitive lands in a captured shell or a tool-call log.
3. `node launch.mjs start w1 && node launch.mjs start w2` - and read the flags in that file before
   changing them, they are load-bearing (see below).
4. Phone: `adb tcpip 5555 && adb connect <ip>:5555`. The serial is always **resolved** from
   `adb devices`, never hard-coded - this device changes IP, and its USB link drops on its own.
5. `node pin.mjs --port 9224 --account owner` after any launch, kill, reboot, radio cycle or
   `install -r`: every one of those re-locks the encryption PIN.

> **The archived copies are anonymised.** This repository is public, so the two accounts appear as
> `owner` and `peer`, their display names as `OWNER DISPLAY NAME` / `PEER DISPLAY NAME`, the DM under
> test as the nil UUID and the phone as `192.168.1.100`. A check compares rendered text against the
> display name, so those two constants have to be filled in before a run - grep for them. Every file
> still parses as shipped; nothing else was changed.

## The files

**The library - everything else imports these.**

| File | Role |
| ---- | ---- |
| `cdp.mjs` | The whole CDP client: targets, evaluate, `realClick`, `until`, focus emulation. |
| `chat.mjs` | Chat primitives shared by every check - `ensureChat`, `openConversation`, `send`. The single definition of "a message arrived", so two checks cannot disagree for harness reasons. |
| `watch.mjs` | Continuous observation: console, page errors, HTTP, WebSocket. Attached by every runner. |
| `phone.mjs` | adb, app lifecycle, notifications, the WebView. |
| `login.mjs`, `pin.mjs` | The two auth gates. `login.mjs --match cas.emse.fr` also drives the phone's system-browser login. |
| `a1.py` | Native Android surfaces via `uiautomator2`, for what the WebView cannot see. |
| `tabs.mjs` | Multi-tab helpers (leader/follower). |

**Checks** - `msg*` `fwd*` `tab*` `life` `notif*` `heal` for the campaign phases;
`recon` `echo1` `reloaddl` `losshunt` `hidden-drain` `reload-loss` are per-defect reproductions,
each named after the work package it settles.

`check-pdf-anchor` `check-pdf-render` `check-feed-retry` are regression checks for UI fixes that
**no unit test can cover**, because each defect is a property of a running render: where a zoom
lands, what is on screen *between* two rasterisations, and which branch of an `{#await}` a template
reads its state from. Each was validated as a negative control against the unfixed build before its
green verdict was believed - and each earned that rule the hard way. `check-pdf-render` returned
PASS on a ladder it had never walked (the zoom control's `aria-label` is `Agrandir`, so a `/zoom/i`
selector clicked nothing), which is why every step now asserts its own post-condition; and
`check-feed-retry` reported FAIL against a page that was visibly rendering posts, because it counted
`article`/`data-post-id`, neither of which the feed has - `PostCard`'s root carries `group/card`.

`recon.mjs` deserves singling out: **it is the only thing that can SEE this codebase's loss class**,
by diffing the markers W1 shows against the markers W2 shows for one thread. A green per-check
verdict is not a substitute - reconciliation is what found WP-LOSS-1 and WP-ECHO-1.

**Tools** - `launch.mjs` `reload-both.mjs` `cleanup.mjs` `results.mjs` `console.mjs` `shot.mjs`
`state.mjs` for operating the rig; `net.mjs` `netwatch.mjs` for the radios; `purge-devices.mjs`
drives the real device panel (not the database); `storm.mjs` `syncbanner.mjs` `outbox-probe.mjs`
were written to diagnose the 2026-08-07 retransmission storm and generalise to any "who is
generating this traffic" question.

## Operating it

Facts about the instrument that are not guessable from the code, each of which has cost at least one
run.

**The browsers**

- **Reload W1 and W2 onto the CURRENT bundle before any repair check.** A client left open across a
  deploy is running yesterday's code, and every line it logs will be read as though it were not.
  `bundle-id.mjs` reports what each one is actually on; it refuses to measure twice on purpose.
- **`connect()` in `cdp.mjs` is not ready-aware.** Use `client(port)` from `chat.mjs`, which waits
  for the page. (Cost two runs.)
- A relaunch keeps the login but **re-locks the PIN**, and so do a kill, a reboot, a radio cycle and
  an `install -r`.

**The phone**

- **adb over TCP is what makes a session stable**: `adb tcpip 5555` then `adb connect <ip>:5555`.
  Both transports attached means **every `adb` call needs `-s`**.
- The WebView pid changes on every cold start, so re-read `/proc/net/unix | grep webview_devtools`
  and redo the `adb forward` after one. **The socket exists only once the WebView does**: a process
  started by a broadcast has neither a window nor a devtools socket (see WP-DIRECTBOOT-1), so poll
  for the socket rather than concluding the app is not running - and a stale forward does not error,
  it connects to nothing.
- **`run-as <pkg>` reaches the app's private files** on a debug build, which is how a cache is
  emptied to force a code path that would otherwise be skipped (`files/avatar_*.jpg`). One of the
  few things a debug build is better for.
- USB stays the fastest path for `install -r`, and this device's USB link drops on its own.
- **Use PowerShell for any `adb shell` command carrying an absolute device path** - Git Bash
  rewrites `/sdcard/x` into a Windows-ish path and the command silently targets nothing.
- The phone's entire web console is in logcat under `Tauri/Console`. Capture continuously to a file:
  a busy device overruns the ring buffer in minutes.
- Re-logging the phone in **is** automatable: the Android login opens the SYSTEM browser, so forward
  CDP to `localabstract:chrome_devtools_remote` and run `login.mjs --match cas.emse.fr`. Never
  `realClick` the CAS fields - focus by element and assert `activeElement`.

**Building for it**

- `bun tauri android build --target aarch64 --debug`, then install
  `.../apk/universal/debug/app-universal-debug.apk` - **not** `arm64/`, which is stale.
- **Never run an Android or iOS build next to anything else that builds the frontend.**
  `beforeBuildCommand` is `bun run build`, and two builds writing `build/` ship an app that cannot
  boot. `scripts/check-bundle-consistency.mjs` now fails the build rather than letting it through.
- The version name no longer moves between builds - the discriminator is `lastUpdateTime`.
- `bun run test` fails with locale mismatches after an Android build; re-run
  `bun run paraglide:compile` first.

## Rules that make a result trustworthy

**Thirty-one** harness faults produced a false verdict before these were learnt. They are distilled,
with their examples, in [testing-methodology](../../docs/wiki/testing-methodology.md) - read that
page before writing a check or believing one. The five that decide whether a run is worth reading at
all:

- **Observation is part of every check, not a debugging step.** A verdict is `PASS` only if the
  assertions hold *and* the run is clean. A line that turns out to be routine is added to the benign
  list - never ignored in place. Two shipped bugs came out of the logs of *passing* checks.
- **A verdict must never be computed over a projection of its own evidence.** A capture filter is
  presentation; the verdict reads everything.
- **Every action asserts its own post-condition.** An action that cannot prove it took effect still
  yields a verdict, and that verdict is fiction: a kill that killed nothing, a "relaunch" that was a
  new tab, a `pidof` that exits 1 exactly when the thing it measures happens.
- **A locator is a guess unless it is disambiguated, and a DEVICE is a locator.** `/json/list` is not
  creation order; a document-wide text match hits the first hidden row; an `aria-label` must never
  outrank visible text; `.chat-composer-editor` exists on the social feed too, so every use is scoped
  to `.chat-composer-footer`.
- And the meta-rule: **assume a green check is wrong until its evidence says otherwise - and a FAIL
  too.** Check the fixture and the selector before blaming the app. One check passed against a
  fixture with invalid PNG CRCs; another failed looking for a `<canvas>` where the app draws an
  `<img>`.

Two environment traps worth repeating here, because they read as application bugs:

- **Chrome discards every input event on a page it considers hidden**, and native occlusion detection
  marks a fully covered window hidden while `windowState` still says `normal`. Hence the
  `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows` flags in
  `launch.mjs`. A backgrounded tab must therefore be made by focusing another *tab*, never by
  covering the window.
- **`am force-stop` is not "the user killed the app".** Android's STOPPED state cancels every FCM
  broadcast until a manual launch, so any push-dependent check must use a swipe from recents or
  `am kill` - and `am kill` will not reclaim a foreground process, so go HOME first and assert the
  death.

## When the campaign ends

Restore Firefox as the device's default browser -
`cmd role add-role-holder android.app.role.BROWSER org.mozilla.firefox`. It was switched to Chrome
only because Firefox exposes no CDP.
