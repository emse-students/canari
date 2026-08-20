# Cross-client test harness

The rig that drives **three real Canari clients at once** against the live deployment: two desktop
Chrome profiles and an Android device. It exists because a whole class of Canari bug is invisible to
a unit test and to a single client - a message the sender shows as delivered and the receiver never
stores, a tab that stops receiving while looking healthy, a notification that is not dismissed on the
other device. Every defect it found is written up in
[cross-client-testing](../../docs/wiki/cross-client-testing.md), the campaign's live board; its
design is [cross-client-campaign](../../docs/wiki/cross-client-campaign.md). This file is about the
rig itself.

It is **not** a CI suite and must never become one. It drives PRODUCTION with two real accounts, it
needs a phone plugged in, and several checks take minutes. It is an audit instrument: pick it up when
you need to know what actually happens across clients, not on every commit.

## Where things live

**The instruments are here and are the ones that run.** There is no second copy and no archive: an
archived rig rots, and a rig that lives outside the repository is not reviewed. Everything in this
directory is anonymised by construction - the two accounts are `owner` and `peer` everywhere, and no
check spells a name.

**The state is deliberately NOT here**, in a sibling directory `../../../canari-harness`:

| Outside                        | Why it may not live in the repository                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| `test-accounts.json`           | Logins and PINs for two production accounts. This repository is PUBLIC: outside the work tree they cannot be committed at all, which is a structure; a `.gitignore` rule would only be a policy. |
| `chrome-w1/` `chrome-w2/`      | These directories ARE W1 and W2 - profile holds the MLS identity, the session and the enrolment. `git clean -xdf` does not spare a gitignored directory, and re-enrolling costs the 2FA step no tool here can answer. |
| `results.ndjson`               | The verdict record. A row carries the condensed dirt of its run, which quotes captured console lines naming real conversations. |
| `apk/` `a1-baseline/` `logs/`  | Bulk artefacts. No script references them; they are installed and read by hand. |

One constant bridges the two, `STATE_DIR` in `names.mjs`, and it has exactly **three** consumers -
`launch.mjs` for the profiles, `accounts.mjs` for the logins, `results.mjs` for the verdict record.
Nothing else knows the split exists.

## What it drives

| Client | What it is                     | Reached by                                          |
| ------ | ------------------------------ | --------------------------------------------------- |
| **W1** | Desktop Chrome, `owner`        | CDP on `localhost:9224`                              |
| **W2** | Desktop Chrome, `peer`         | CDP on `localhost:9223`                              |
| **A1** | The Tauri WebView on the phone | CDP on `localhost:9333` via `adb forward`            |

One driver (`cdp.mjs`) speaks to all three - the WebView is a Chrome target like any other. `a1.py`
is only for surfaces the WebView cannot reach (the notification shade, the system PIN, the launcher).

**A1's devtools socket is `webview_devtools_remote_<pid>`, so it changes on every restart.** A
forward left over from an earlier session stays listed and points at nothing, or at another app's
socket - the phone then reads as "not debuggable" while it is in the foreground. `a1forward.mjs`
derives it from the running pid and fails loudly when the target list is empty.

## Setting it up

1. **Node 24+** (a global `WebSocket` is assumed - there is no Playwright or Puppeteer here), `adb`
   on `PATH`, and Chrome installed.
2. Create the state directory `../../../canari-harness` and put `test-accounts.json` in it, from
   `test-accounts.example.json`. **No credential is ever a command-line argument**: `login.mjs` and
   `pin.mjs` read the file themselves through `accounts.mjs`, so nothing sensitive lands in a
   captured shell or a tool-call log.
3. `cp names.example.mjs names.mjs` and follow its header - the real display names go in the state
   directory, this copy is the pointer. Both are gitignored.
4. `node launch.mjs start w1 && node launch.mjs start w2`. Read the flags in that file before
   changing them; they are load-bearing (see *Operating it*).
5. Phone: plug it in, then `node a1forward.mjs`.
6. `node unlock.mjs` after any launch, kill, reboot, radio cycle or `install -r`: every one of those
   re-locks the encryption PIN, and a locked client does not fail honestly - it renders, answers, and
   reports on an empty store.

## Running it

`run.mjs` is the one way in. It refuses to start a phase whose devices are not ready, and it reads
verdicts back from the record rather than off stdout, because several scripts print a raw observation
dump *after* their verdict.

```
node run.mjs                      what exists, what is covered, what is not
node run.mjs MSG                  every script of one phase
node run.mjs MSG TYPE READ        several phases, in order
node run.mjs FWD --repeat 5       five passes, with a cross-pass table and a per-pass server window
node run.mjs --file msg3.mjs      one script, still with the preflight
node run.mjs --preflight W1 A1    the rig check ALONE, no script, no verdict
```

`checks.mjs` is the manifest - which script covers which phase, and which devices each phase needs.
**Keep it in step with the dashboard**: when a phase gains a script, add it there in the same commit.

A pass is `PASS` only if its assertions hold **and** its window is clean on web, on the phone and on
the server. `srvlog.mjs` classifies the whole server window - `--shapes` collapses `unexplained` and
`notable` into distinct sentences - and `srvclassify-selftest.mjs` pins every rule against a line
whose bucket is known.

## The files

**The library** - everything else imports these.

| File | Role |
| ---- | ---- |
| `cdp.mjs` | The whole CDP client: targets, `evaluate`, `stableCentreOf`, `clickAtPoint`, `realClick`, `until`, focus emulation. |
| `chat.mjs` | Chat primitives shared by every check - `client`, `ensureChat`, `openConversation`, `send`, `clickBubbleAction`. The single definition of "a message arrived", so two checks cannot disagree for harness reasons. |
| `watch.mjs` | Continuous observation: console, page errors, HTTP, WebSocket. Attached by every runner. |
| `srvlog.mjs` | The server observer, held to the same bar as the two clients: the whole window is classified, and it partitions by SUBJECT because production is shared. |
| `names.mjs` / `accounts.mjs` | The only two readers of machine-local truth. Every other file goes through them. |
| `phone.mjs`, `a1forward.mjs` | adb, app lifecycle, notifications, the WebView. |
| `login.mjs`, `pin.mjs`, `unlock.mjs` | The auth gates. `unlock.mjs` unlocks every client it can identify; `login.mjs --match cas.emse.fr` also drives the phone's system-browser login. |
| `net.mjs` | The radios. `armCut`/`cutHard` exist because CDP offline emulation leaves an already-established WebSocket alone - the plain cut could never produce a receiver-side disconnection, so MSG-9 had never once measured the thing it was named for. |
| `a1.py` | Native Android surfaces via `uiautomator2`, for what the WebView cannot see. |

**Checks** - `msg*` `type` `read` `mut` `search` `mention` `fwd*` `grp-traffic` `del1` `tab*` `life`
`notif*` `heal*` for the campaign phases, named after the dashboard rows they answer.

`recon.mjs` deserves singling out: **it is the only thing that can SEE this codebase's loss class**,
by diffing the markers W1 shows against the markers W2 shows for one thread, id by id. A green
per-check verdict is not a substitute - reconciliation is what found WP-LOSS-1 and WP-ECHO-1. It
covers the phone too, reading the native store in place over `plugin:sql|select` from CDP, because
pulling it would put a real account's conversations on this machine.

`check-pdf-anchor` `check-pdf-render` `check-feed-retry` are regression checks for UI fixes that **no
unit test can cover**, because each defect is a property of a running render: where a zoom lands,
what is on screen *between* two rasterisations, and which branch of an `{#await}` a template reads
its state from. They are reachable from no manifest - they answer a finished campaign - but
[durable-rules](../../docs/wiki/durable-rules.md) cites `check-feed-retry.mjs` as the evidence behind
a rule, so deleting them would leave that rule with nothing under it. Each was validated as a
negative control against the unfixed build before its green verdict was believed, and each earned
that rule the hard way: `check-pdf-render` returned PASS on a ladder it had never walked (the zoom
control's `aria-label` is `Agrandir`, so a `/zoom/i` selector clicked nothing), and `check-feed-retry`
reported FAIL against a page that was visibly rendering posts, because it counted `article` and
`data-post-id`, neither of which the feed has.

`burn.mjs` is the one to copy the SHAPE of. It reproduces a RACE - send, reload inside the
unawaited-checkpoint window, send again - and a run that loses that race delivers the second message
exactly like a run that wins it. So it reads the premise separately from the result (the durable
send-ledger's deficit, before and after the reload) and answers `INCONCLUSIVE` rather than `PASS`
when the window was never entered. It does NOT rest its verdict on the repair's log line either: a
reload that skips the PIN gate initialises before a session can attach, and on the passing run that
line was missed entirely while the repair had plainly happened. The reload is gated on the ledger
actually showing a deficit, because a fixed delay cannot reliably enter a window ~58 ms wide on web.

**Tools** - `launch.mjs` `reload.mjs` `cleanup.mjs` `shot.mjs` `state.mjs` `results.mjs` operate the
rig; `purge-devices.mjs` drives the real device panel (not the database); `ladder.mjs` `wsidle.mjs`
`navclose.mjs` `synboot.mjs` `synopen.mjs` `synwatch.mjs` `ckpt.mjs` `burn.mjs` are the probes that
took a specific measurement and were kept because the measurement is repeatable.

Three exist because a run once measured something other than what it claimed to, and each closes that
hole with an assertion rather than a habit:

- **`bundle-id.mjs` - run it before believing any verdict about a fix.** "Reload the browsers onto the
  new build" was a rule for days with nothing behind it, and a reload served from cache is
  indistinguishable from one that was not. SvelteKit stamps a per-build `__sveltekit_<id>` as a
  global, so the running page carries its build id while the origin serves the current one: comparing
  them turns the rule into a check that exits non-zero. **A navigation does not pick up a deploy -
  only `Page.reload {ignoreCache:true}` does.**
- **`ssh.mjs` - the single door to production.** `ssh` resolves to **Git's** binary under Bash, which
  mangles the backslashes in the cloudflared `ProxyCommand`, so the same gateway probe answered
  differently depending on which shell launched the run. It picks Windows OpenSSH explicitly.
- **`rawcheck.mjs` - the escapes in a page-side expression belong to the PAGE, not to Node.** Every
  expression this rig evaluates in a browser is a template literal, and Node reads its escapes on the
  way out: `/[\r\n]+/` arrives cut in half by a real newline and `evaluate` throws, `/\s+/` arrives as
  `/s+/` and quietly matches the letter `s`. Four sites had it on 2026-08-20, including `HEADER_NAME` -
  written doubled, halved hours earlier by a commit that rewrote the lines around it, so
  `ensureConversation` threw on every call - and `comm8`'s pattern for "the peer announced a seed",
  which could not say yes. Write them `String.raw`; this exits non-zero when one is not, and it was
  validated as a negative control against all four before its clean verdict was believed.

`scratch/` is gitignored and is where one-shot probes go. Before it existed they accumulated beside
the real checks until **285 of 362 files were residue** and nobody could tell an instrument from a
leftover. **One-shot probes are not kept**, so a `.mjs` named in a historical write-up on the wiki -
`webstate.mjs`, `unloadframe.mjs`, `falseloss*.mjs`, `check-loss-a1.mjs`, `trace-arrival.mjs`,
`probe-csp-blob.mjs` - is a probe that answered its question and was removed. The measurement stands;
the file is gone, which is why every write-up states the technique in full.

### recon.mjs measures the store, not the screen

The reconciliation is the campaign's only instrument for the silent-loss class. Until 2026-08-11 it
read campaign markers out of the rendered message pane, and every problem that design had came from
one fact: **the pane is a window onto the history, not the history.** It had to scroll; scrolling
pages 50 rows at a time; so it needed a time window to stay honest, a coverage proof, and about a
minute per side. Run against a 1 804-message DM it read **60 rows** and printed `reconciled: true` -
its marker pattern had drifted and matched nothing, it called an empty difference over an empty set a
reconciliation, and its scroll loop assigned `scrollTop` without dispatching an event, so at the top
it assigned 0 to 0 and concluded it had reached the beginning of history after four steps.

It reads both clients' IndexedDB now. Rows are ciphertext at rest but `id` and `conversationId` are
plaintext, so the two stores compare exactly without decrypting anything: **1 804 = 1 804, shared
1 804, zero either side, in 0.58 s** against roughly two minutes for a windowed answer covering 3 % of
the conversation. It works on a conversation of any size because it never looks at a window. What it
cannot say is that a message *decrypted*, only that both clients hold it - rendering and decryption
are asserted per check, by the marker each one sends.

Four properties worth keeping:

- **Membership comes from the `conversations` store, not from the message rows.** Keyed off messages
  alone, a conversation a client is in but has received *nothing* for has no rows, so it looks like a
  conversation the client is not in - and a total loss, the worst case, would be the one case that
  reconciled silently.
- **A conversation `removed` on either side is expected to diverge**, and is reported apart rather
  than as a difference. That is what deleting it means.
- **`VACUOUS` is a third verdict, not a flag on a boolean**, and it exits non-zero.
- **It REFUSES to read a Tauri client rather than answer wrongly.** A1 carries a `CanariDB_*` database
  that is present, openable, correctly shaped and **permanently empty** - a vestige of the shared web
  code path - while its real store is SQLite behind Tauri. Read through it, a healthy phone showing
  nine conversations reports zero of everything. It answers `WRONG STORE`, names the runtime, and
  reports how many conversations the client is showing. **The phone needs `--rightUrl
  tauri.localhost`**, because its WebView serves from there and not from the domain.

### The other instruments, and what each was wrong about first

- **`reload.mjs`** is the other half of `bundle-id.mjs`: it detects staleness AND repairs it, then
  re-asserts the build id rather than assuming the reload took.
- **`unlock.mjs`** resolves which account owns which port from `test-accounts.json`, navigates to a
  route where the gate actually MOUNTS, and spawns `pin.mjs` - so the recurring "you forgot the PIN"
  costs one idempotent command, and no real first name is typed into a shell line.
- **`onetab.mjs`** closes every app tab but the front one. A second tab is a second MLS client on that
  profile, and `client()` resolves by position among the tabs; `run.mjs` runs the same repair before
  every job.
- **`awaiting.mjs` was OBSOLETE and is deleted** - the durable awaiting-history registry it read no
  longer exists, so a re-run would find an empty store on every client and report health it cannot
  observe. It is worth remembering for two faults that apply to any probe: it looked for evidence in a
  `_reason` companion key when the registry stored `{since, reason}` as the JSON *value*, so it
  reported every marker on every client as legacy - a unanimous answer contradicting a measurement
  taken the day before, which is what a vacuous probe always looks like; and it returned `[]` rather
  than `null` when it could not read a store, which is "a failed read is not an empty store" broken
  inside the instrument that exists to enforce it. The observable is now the LOG line
  (`[HISTORY_RECONCILE] … group(s) asked`), not a stored key.
- **The group fixture is `newgroup.mjs` + `invite.mjs`**, shared by the DEL, GRP and HEAL rigs. The
  two halves are needed apart: creating a group is what HEAL-W2 needs, while the ADD is separately the
  campaign's only cheap, deterministic epoch generator.
- **Continuous sampling replaces any two-sample arrival check**, and it is a property of the checks
  themselves rather than of a standalone probe: `watch.mjs` observes throughout, and a check that
  measures an arrival samples the receiver rather than looking twice.

## Operating it

Facts about the instrument that are not guessable from the code, each of which has cost at least one
run.

**The browsers**

- **Reload W1 and W2 onto the CURRENT bundle before any repair check.** A client left open across a
  deploy is running yesterday's code, and every line it logs will be read as though it were not.
- **`connect()` in `cdp.mjs` is not ready-aware.** Use `client(port)` from `chat.mjs`, which waits
  for the page. (Cost two runs.)
- A relaunch keeps the login but **re-locks the PIN**, and so do a kill, a reboot, a radio cycle and
  an `install -r`.
- Two isolated browser contexts are two devices; never assert a wall clock in a check.

**The phone**

- The WebView pid changes on every cold start, so redo the forward with `a1forward.mjs`. **The socket
  exists only once the WebView does**: a process started by a broadcast has neither a window nor a
  devtools socket (see WP-DIRECTBOOT-1), so poll for the socket rather than concluding the app is not
  running - and a stale forward does not error, it connects to nothing.
- Both transports attached means **every `adb` call needs `-s`**.
- **`run-as <pkg>` reaches the app's private files** on a debug build, which is how a cache is emptied
  to force a code path that would otherwise be skipped. One of the few things a debug build is better
  for.
- **Use PowerShell for any `adb shell` command carrying an absolute device path** - Git Bash rewrites
  `/sdcard/x` into a Windows-ish path and the command silently targets nothing.
- The phone's entire web console is in logcat under `Tauri/Console`. Capture continuously to a file:
  a busy device overruns the ring buffer in minutes.
- **The phone does not pick up a deploy at all**: `frontendDist` is `../build`, so it serves the
  bundle inside its APK. Verifying a UI change there means building and installing one.

**Building for it**

- `bun tauri android build --target aarch64 --debug`, then install
  `.../apk/universal/debug/app-universal-debug.apk` - **not** `arm64/`, which is stale.
- A Kotlin-only change does **not** need the Tauri build: `gradlew :app:assembleUniversalDebug` in
  `gen/android` packages the assets already on disk. The unit-test variants are
  `testUniversalDebugUnitTest` / `testArmDebugUnitTest` - `:app:testDebugUnitTest` is ambiguous, and
  a stale report from the other variant will happily answer a question about this one.
- **Never run an Android or iOS build next to anything else that builds the frontend.**
  `beforeBuildCommand` is `bun run build`, and two builds writing `build/` ship an app that cannot
  boot. `scripts/check-bundle-consistency.mjs` fails the build rather than letting it through.
- An Android build leaves Paraglide resolving to English, which used to fail four locale-asserting
  test files afterwards. `bun run test` now compiles Paraglide itself, so there is nothing to
  remember - a rule that says "run X first" was a missing dependency, not a rule.

## Rules that make a result trustworthy

**Thirty-one** harness faults produced a false verdict before these were learnt. They are distilled,
with their examples, in [testing-methodology](../../docs/wiki/testing-methodology.md) - read that
page before writing a check or believing one. The ones that decide whether a run is worth reading at
all:

- **Observation is part of every check, not a debugging step.** A verdict is `PASS` only if the
  assertions hold *and* the run is clean. A line that turns out to be routine is added to the benign
  list - never ignored in place. Two shipped bugs came out of the logs of *passing* checks.
- **A verdict must never be computed over a projection of its own evidence.** A capture filter is
  presentation; the verdict reads everything.
- **Every action asserts its own post-condition.** An action that cannot prove it took effect still
  yields a verdict, and that verdict is fiction: a kill that killed nothing, a "relaunch" that was a
  new tab, a `pidof` that exits 1 exactly when the thing it measures happens.
- **A click must be able to say what RECEIVED it.** `clickBubbleAction` computed its own coordinates
  and so grew its own dispatch, inheriting no hit-test, no recorder and no parking - it clicked blind
  for as long as it existed, and its misses surfaced fifteen seconds later as a missing dialog,
  indistinguishable from an application bug. Points are the only part that varies, so `clickAtPoint`
  is the primitive and `realClick` is one way of finding a point.
- **A locator is a guess unless it is disambiguated, and a DEVICE is a locator.** `/json/list` is not
  creation order; a document-wide text match hits the first hidden row; an `aria-label` must never
  outrank visible text; `.chat-composer-editor` exists on the social feed too, so every use is scoped
  to `.chat-composer-footer`.
- **A blocked job is not a crashed one.** A pass whose setup throws never ran, so it has no verdict -
  recording it as a failure confuses "the app misbehaved" with "the instrument could not be brought
  to a state where the question is askable".
- And the meta-rule: **assume a green check is wrong until its evidence says otherwise - and a FAIL
  too.** Check the fixture and the selector before blaming the app. One check passed against a fixture
  with invalid PNG CRCs; another failed looking for a `<canvas>` where the app draws an `<img>`.

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

## Standing constraints

- Runs against **production**. **Every test message goes in the two-test-account DM and nowhere
  else.** Anything needing a channel uses the `Campagne de test` community, never MiTV - a private
  channel there is readable by every association admin.
- **No PIN, login, display name, device id, group id or device serial goes in a committed file.** The
  peer's real display name reached the public archive once already, through a check that spelt it
  inline rather than importing it.
- **Clean up after the campaign.** It creates groups, devices and backlogs on the production database
  that later runs then measure and cannot tell from real traffic - see the cleanup section of the
  dashboard. Restore Firefox as the device's default browser afterwards
  (`cmd role add-role-holder android.app.role.BROWSER org.mozilla.firefox`); it was switched to
  Chrome only because Firefox exposes no CDP.
