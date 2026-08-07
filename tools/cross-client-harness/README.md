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

## Rules that make a result trustworthy

Twenty-two harness faults produced a false verdict before these were learnt. Each is written up in
the wiki; collectively they say four things, and ignoring any of them costs a re-run at best and a
wrong bug report at worst.

- **Observation is part of every check, not a debugging step.** A verdict is `PASS` only if the
  assertions hold *and* the run is clean. A line that turns out to be routine is added to the benign
  list - never ignored in place. Two shipped bugs came out of the logs of *passing* checks.
- **Every action asserts its own post-condition.** An action that cannot prove it took effect still
  yields a verdict, and that verdict is fiction: a kill that killed nothing, a "relaunch" that was a
  new tab, a `pidof` that exits 1 exactly when the thing it measures happens.
- **A check that puts the app through a transition must restore every precondition that transition
  destroys** - and a precondition found by one check belongs to every check sharing the transition.
  A kill, a reboot, a radio cycle and an `install -r` all re-lock the PIN.
- **A locator is a guess unless it is disambiguated, and a DEVICE is a locator.** `/json/list` is not
  creation order; a document-wide text match hits the first hidden row; an `aria-label` must never
  outrank visible text; `.chat-composer-editor` exists on the social feed too, so every use is scoped
  to `.chat-composer-footer`.
- And the meta-rule: **assume a green check is wrong until its evidence says otherwise - and a FAIL
  too.** Check the fixture and the selector before blaming the app. One check passed against a
  fixture with invalid PNG CRCs; another failed looking for a `<canvas>` where the app draws an
  `<img>`.

Two environment traps worth stating outright, because they read as application bugs:

- **Chrome discards every input event on a page it considers hidden**, and native occlusion detection
  marks a fully covered window hidden while `windowState` still says `normal`. Hence the
  `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows` flags in
  `launch.mjs`. A backgrounded tab must therefore be made by focusing another *tab*, never by
  covering the window.
- **`am force-stop` is not "the user killed the app".** Android's STOPPED state cancels every FCM
  broadcast until a manual launch, so any push-dependent check must use a swipe from recents or
  `am kill` - and `am kill` will not reclaim a foreground process, so go HOME first and assert the
  death.
