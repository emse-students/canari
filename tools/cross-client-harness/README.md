# Cross-client test harness

The rig that drives **three real Canari clients at once** against ONE estate named by ONE constant
(`SITE` in `names.mjs`: the LOCAL docker estate, or `dev.canari-emse.fr` since 2026-10-24 - and
NEVER production, which the rig refuses outright, see *The target*): two desktop Chrome profiles and an
Android device. It exists because a whole class of Canari bug is invisible to
a unit test and to a single client - a message the sender shows as delivered and the receiver never
stores, a tab that stops receiving while looking healthy, a notification that is not dismissed on the
other device. Every defect it found is written up in
[cross-client-testing](../../docs/wiki/cross-client-testing.md), the campaign's live board; its
design is [cross-client-campaign](../../docs/wiki/cross-client-campaign.md). This file is about the
rig itself.

It is **not** a CI suite and must never become one. It drives a whole running estate with two real
accounts, it needs a phone plugged in, and several checks take minutes. It is an audit instrument:
pick it up when you need to know what actually happens across clients, not on every commit.

**It is built on ATOMS** - one file per gesture, each ending on a fact rather than a clock - and
[`atoms.mjs`](atoms.mjs) is the index of them. Read that section before writing anything here.

## Where things live

**The instruments are here and are the ones that run.** There is no second copy and no archive: an
archived rig rots, and a rig that lives outside the repository is not reviewed. Everything in this
directory is anonymised by construction - the two accounts are `owner` and `peer` everywhere, and no
check spells a name.

**The state is deliberately NOT here**, in a directory outside the work tree (moved further out on 2026-09-03):

| Outside                        | Why it may not live in the repository                                  |
| ------------------------------ | ---------------------------------------------------------------------- |
| `test-accounts.json`           | Logins and PINs for the two campaign accounts. This repository is PUBLIC: outside the work tree they cannot be committed at all, which is a structure; a `.gitignore` rule would only be a policy. |
| `chrome-w1/` `chrome-w2/`      | These directories ARE W1 and W2 - profile holds the MLS identity, the session and the enrolment. `git clean -xdf` does not spare a gitignored directory. **Since 2026-09-02 losing one no longer costs a 2FA**: the campaign's accounts are dedicated test accounts. It still costs a DEVICE, which is what actually changes what a row measures. |
| `test-accounts.json`           | Still outside, and still for the same reason after the move to a LOCAL target: the accounts are ordinary users on the PRODUCTION identity provider, because local authenticates against it by decision 8 of the workflow migration. A local target does not make the password local. |
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
| **I1** | The Tauri WebView on the iPhone | the WebKit inspector bridge on `localhost:9444` (`pymobiledevice3 webinspector cdp`), WDA for the rest |

**The iPhone is `CANARI_PHONE=ios`**: `phone-any.mjs` then hands a row `phone-ios.mjs`, which keeps
`phone.mjs`'s interface over WDA, Notification Center and the syslog, and the I1 connection performs
every CDP `Input.*` frame as a WDA touch or key (`webkit-input.mjs`) - the WebKit protocol has no
`Input` domain. Which rows run on it, and what each still needs, is
[cross-client-ios](../../docs/wiki/cross-client-ios.md).

**Two I1 traps (2026-10-02).** `pymobiledevice3` must be reachable - set `PYMOBILEDEVICE3` to the
executable; `attached()` throws without it rather than reporting no phone. And starting WDA brings
its runner to the foreground, so Canari goes to the background and relocks on the PIN screen: every
WDA session starts there, and a tap on "Deverrouiller" can land on a logout control when the
keyboard shifts the layout - screenshot before each tap.

One driver (`cdp.mjs`) speaks to all three - the WebView is a Chrome target like any other. `a1.py`
is only for surfaces the WebView cannot reach (the notification shade, the system PIN, the launcher).

**A1's devtools socket is `webview_devtools_remote_<pid>`, so it changes on every restart.** A
forward left over from an earlier session stays listed and points at nothing, or at another app's
socket - the phone then reads as "not debuggable" while it is in the foreground. `phone.mjs`
derives it from the running pid every time and refuses to report success until CDP has answered.

## The target: the local estate or dev, and production is refused

**An estate is `local` or `dev`, and there is no third value** (R1 of the 1.4.1 campaign,
2026-10-24). Until then `estate.mjs` decided with one boolean and routed everything not local to
PRODUCTION's containers, so pointing `SITE` at dev would have read production's tables and logs and
reported them as dev's.

- **`site.mjs` is the only door to `SITE` and `ORIGIN`**, and its evaluation throws
  `EstateRefusedError` for any other `SITE` - production under either name, `http://dev...`, an
  undeclared host - before the importing entry point runs a line. `archive/estate-selftest.mjs`
  fails the gate if any file takes `SITE` or `ORIGIN` from `names.mjs` directly - by a named,
  namespace (`N.SITE`), destructured-dynamic or `createRequire` import. **`SITE` and every web
  `ORIGIN` must be EXACTLY an origin** (`https://dev.canari-emse.fr`, no trailing slash, path, dot
  or upper case): the rig compares them as strings. The scan covers `.mjs` only; the one other
  driver, `a1.py`, drives the phone's native surfaces and reads no estate.
- **`estate.mjs` has no production branch.** Local is `docker exec canari-local-*`; dev is `ssh
  <DEV_SSH_HOST>` (machine-local, in `names.mjs`) and the container found BY COMPOSE LABEL
  `com.docker.compose.project=canari-dev` - one running container per service, the label re-read
  before use, exit `97` otherwise - the lookup `infrastructure/dev/reset-dev-to-seed.sh` makes. The
  routing is pure (`estate-target.mjs`); the self-test drives it with stub transports and runs the
  resolver itself under `sh` against a fake `docker`.
- **A page is attached to or navigated to by ALLOWLIST** (`pageVerdict` / `refuseForeignPage` in
  `estate-target.mjs`): it must be on `SITE`'s origin, a Tauri engine page (`http://tauri.localhost`,
  `tauri://localhost`), an inert browser page (`about:blank`, the new-tab page, Chrome's error
  page) or an identity provider over https (MiConnect, its legacy name, CAS). Enforced in the ONE
  attach path, `listTargets` in `cdp.mjs` (it refuses if ANY listed page is off the list, so a
  profile still sitting on production stops the run before a socket exists), in every
  `Page.navigate` / `Target.createTarget` a connection sends, and in `launch.mjs` `startBrowser`
  (its landing url, and the tabs the profile restored). With no estate registered (`site.mjs` not
  yet evaluated) `listTargets` loads it; the guard itself never passes a page by default.
  A browser `startBrowser` launched that comes back with a refused tab is KILLED, not left running.
  **ONE BROWSER THE RIG DOES NOT OWN is judged per target instead:** the phone's own Chrome, where
  `login.mjs` finds the IdP form beside whatever tabs the phone's user left open. There
  `untrustedBrowserPages` lists without judging, and `judgedTarget` judges each tab before it is
  attached. Every page the rig drives is still judged in full. `onetab.mjs` and `iosbench.mjs`
  report a refusal as a refusal, not as "not answering", and `onetab.mjs` closes refused tabs
  (`/json/close`, never a navigation).
- **A NATIVE CLIENT RUNNING A PRODUCTION BUILD IS NOT REFUSED BY THE PAGE GUARD.** A Tauri app's
  page is `http://tauri.localhost` / `tauri://localhost` whatever origins its build baked in, so
  the guard cannot see that an APK or an iPhone build talks to production. That is checked AFTER
  the fact, by `pin.mjs` (which origins the client actually contacted), and before the fact only for
  APKs the rig builds itself (`a1apk.mjs` greps the packaged bundle). An installed store or
  TestFlight build is not inspected: read what it contacts with `pin.mjs` before a row uses it.
- **Every ledger row records its `estate` and `site`**, and `rows.mjs` reads only the rows of the
  estate `SITE` names (a row older than R1 carries none and counts as local): one `STATE_DIR` serves
  both estates.
- **Verify the target before a run**: `bun estate.mjs` names the estate and resolves its containers
  (read-only); `archive/run.mjs`'s preflight does the same on its first lines and refuses on a miss.
- **Dev is shared with testers.** Reads are free; writes to dev's database and Redis are allowed by
  the owner for campaign-owned fixtures only. Nothing the rig runs may write anywhere else.

### What a row may destroy on dev: the campaign ledger (R5)

**On dev a destructive gesture touches only what the campaign CREATED**, and "created" is a record
written at creation time, never a name that looks minted. One append-only ledger per estate,
`STATE_DIR/campaign/<estate>.ndjson` (`campaign.mjs`; decisions pure in `campaign-ledger.mjs`,
pinned by `archive/campaign-selftest.mjs`):

- **Written by** `groupnav.createGroup` / `createDM`, `comm.createCommunity` / `createChannel`,
  `newdevice.mjs` (the device it mints) and `campaign-fixtures.mjs` (fixtures, the four accounts and
  each seat's device, with their ids).
- **Read by `assertCampaignOwned`, called before the first click of**: `groupnav.deleteGroup`;
  `comm.openCommunitySettings` (the one panel where a community is deleted, left, re-roled, purged of
  members, re-permissioned or has its invite rotated); `comm.openChannelSettings` (salon delete,
  access revoke, privacy, write policy); `arm.expireInvite` (a database write); `purge-devices.mjs`
  (every `--only` id, in full - a prefix is a family); `archive/addmember.mjs` `removeMember`
  and `leaveGroup` (moved out of `archive/grp.mjs` for the race rows); `archive/del1.mjs`'s inline delete. Every other destructive runner reaches these.
- **`cleanup.mjs` on dev needs `--only <ids> --expect N`**: the name shapes choose candidates, then
  only the named ids, each owned, with the expected count, are taken - anything off refuses the
  whole sweep. `--dry` prints the exact flags.
- **`stale-devices.mjs` is the device half of that sweep, in the preflight**: every browser device of
  the rig's accounts that no live seat holds and the ledger records creating (each DEV row mints and
  abandons one). Read only by default; `--purge --expect N` purges exactly the N it printed, through
  `purge-devices.mjs`. A web seat that does not answer refuses the plan - its device would look stale.
- **The "Nouvel appareil" notices a mint leaves on the owner's other seats** are dismissed by the
  minting row itself, after its verdict, through the banner's "Compris" (`devicenotice.mjs`, pinned
  by `archive/devicenotice-selftest.mjs`; wired in `archive/devrows.mjs` and `archive/removals.mjs`).
  It is an allowlist of the ids the row minted: the first notice of any other device stops it and is
  reported at `error`, for a human to read. `cleanup.mjs` does not touch notices.
- **Not guarded, deliberately**: `dismissLocally` (it removes only the rig device's own copy of a
  conversation already deleted) and the message deletions of `mut.mjs` and `search.mjs`, which pick
  the bubble by the run term of a message the row itself sent seconds earlier.
- **On local the ledger is written but not required** - the whole estate is the rig's, and the name
  allowlists decide as before.

**The fixtures** - the four accounts signed in, the owner-peer DM, `VENUE` with a public and a
`campaign-private` salon, groups `campaign-g2`, `campaign-g4`, `campaign-big` - are built through
the product by `bun campaign-fixtures.mjs --build` (plan step 2, after the pre-release); without
`--build` it reads and reports what is owed. Each account needs a web seat in `names.mjs`
(`ACCOUNT_OF`, `PORTS`; the plan puts third and fourth on W4/W5). Every group's missing members are
added in ONE bulk Add (`addMembers`), the product's ordinary path, so a fixture's history is one
commit per group and not one per member.

## Setting it up

1. **Node 24+** (a global `WebSocket` is assumed - there is no Playwright or Puppeteer here), `adb`
   on `PATH`, and Chrome installed.
2. **Bring the estate up, and point `SITE` at it.** `make run-services` builds and starts
   `infrastructure/local/docker-compose.yml`. Its database holds no production data (never copied to a workstation).
   Then `SITE` in `names.mjs` is `http://localhost:8081` - nginx, the single entry point, NOT the vite
   dev server. **The dev server is not an estate**: it serves no `_app/version.json`, so every client
   on it reports a build the rig cannot compare and the preflight cannot gate. Two facts the estate
   itself will teach you the hard way otherwise: `frontend-ssr` must be running (without it every
   navigation falls through to `@app_shell` and any route deeper than one segment loads no module at
   all), and the local Postgres superuser is `admin`, not `canari`, which is why `psql` in `ssh.mjs`
   picks the user from `SITE` rather than from a flag.
3. Create the state directory outside the work tree and put `test-accounts.json` in it,
   from `test-accounts.example.json`. **It moved one level further out on 2026-09-03**, when the
   campaign restarted from zero - a root the old path cannot reach is a root that cannot be
   half-inherited. `play-console-sa.json` and `google-services.json` stayed in the previous
   directory on purpose: store and build credentials, not rig state, and other tooling records
   their paths. **No credential is ever a command-line argument**: `login.mjs` and
   `pin.mjs` read the file themselves through `accounts.mjs`, so nothing sensitive lands in a
   captured shell or a tool-call log.
4. `cp names.example.mjs names.mjs` and follow its header - the real display names go in the state
   directory, this copy is the pointer. Both are gitignored.
5. `bun launch.mjs start w1 && bun launch.mjs start w2`. Read the flags in that file before
   changing them; they are load-bearing (see *Operating it*).
6. Phone: plug it in, then `bun phone.mjs` (`bun phone.mjs <port>` for another port).
7. `bun unlock.mjs` after any launch, kill, reboot, radio cycle or `install -r`: every one of those
   re-locks the encryption PIN, and a locked client does not fail honestly - it renders, answers, and
   reports on an empty store.
8. `bun seed-bench.mjs` tops the estate up with what the verification rows look at: 40 feed posts
   (enough to scroll `/posts`), one encrypted video post, six upcoming validated events on the
   `banc-essai` association, and the `banc-defilement` salon in the venue at 100 messages. Every
   count is a target read from the table first, so a second run is reads alone; `--dry` says what is
   owed, `--only` picks parts. Posts and events go through `/api` from the client's own page, the
   salon through W1's composer, because its messages are end-to-end encrypted.

## Running it

`archive/run.mjs` is the one way in. It refuses to start a phase whose devices are not ready, and it reads
verdicts back from the record rather than off stdout, because several scripts print a raw observation
dump *after* their verdict.

```
bun archive/run.mjs                      what exists, what is covered, what is not
bun archive/run.mjs MSG                  every script of one phase
bun archive/run.mjs MSG TYPE READ        several phases, in order
bun archive/run.mjs FWD --repeat 5       five passes, with a cross-pass table and a per-pass server window
bun archive/run.mjs --file msg3.mjs      one script, still with the preflight
bun archive/run.mjs --preflight W1 A1    the rig check ALONE, no script, no verdict
```

`checks.mjs` is the manifest - which script covers which phase, and which devices each phase needs.
**Keep it in step with the dashboard**: when a phase gains a script, add it there in the same commit.

A pass is `PASS` only if its assertions hold **and** its window is clean on web, on the phone and on
the server. `srvlog.mjs` classifies the whole server window - `--shapes` collapses `unexplained` and
`notable` into distinct sentences - and `srvclassify-selftest.mjs` pins every rule against a line
whose bucket is known.

**A 1.4.1 line is judged BY THE ROW** (`ROW_RULES` in `srvlog.mjs`, R6 of
the 1.4.1 campaign, `docs/wiki/cross-client-campaign-1-4-1.md`): a `[COMMIT] DUPLICATE`, an
`awaiting_admission` refusal, a `[BG_WELCOME]` or a removal-bound refusal is `expected` in the rows
that provoke it and `outOfRow` - which breaks `clean` - in any other row and in a window no row
named. A gated row passes its own id (`recordObserved` does it); by hand, `bun srvlog.mjs --since
15m --row DUP-1` or `bun logs.mjs --server --row DUP-1`. A throttled line whose `repeat=` is not 1,
10, 100... is dirt in every row: the throttle is what it would be telling you about. ERROR lines are
never judged per row.

**A network line in a client report renders as `<sentence> <- METHOD /path`**, joined through
`Log.entryAdded`'s `networkRequestId` to the request the classifier already holds - because "the
server responded with a status of 415" names no request, and a dirt line whose subject cannot be
recovered can be neither explained nor fixed. The join is only attempted for `source === 'network'`:
a worker's own `console.log` arrives on the same channel carrying the worker FILE as its `url`, and a
`???` where the method belongs is what that looks like. Classification is untouched by any of it -
every rule and every `ignoringExpectedLog` needle still matches the sentence alone.

**A watch waits for what the world can SERVE, never for the whole sidebar.** `servable.mjs` holds the
predicate and both HEAL rungs use it, with different subsets for the same reason. `healnew.mjs`'s
responder is the PEER, another account, so `activeGroupIds` narrows it per USER; `healrevoke.mjs`'s
responder is the owner's own other device, which the server says is a member of everything the victim
is in, so membership narrows nothing - there the subset is the union of the READY rows of every
client that is up, because a device can only answer for a group whose MLS state it holds. On this
account two groups of twelve are ready NOWHERE, so `syncing === 0` burnt three 600 s deadlines a run
and reported a stall nothing online could have prevented. An empty world is still never settled, and
`theSettlePredicateKnewWhatToWaitFor` is what tells a row that MEANT to return alone from a rig that
failed to read the world.

**A runner names the noise IT provokes, per row, and never widens a shared classifier.** Minting a
device drives the OIDC callback and the device panel, so `watch.mjs` exports `MINT_REFUSALS` (the
`POST /api/auth/refresh -> 401` from a client that has just deleted every cookie), and
`OIDC_LOGIN_NARRATION` and `DEVICE_PANEL_NARRATION` beside `COLD_START_NARRATION` - **named there and
applied nowhere**, so naming them stays the caller's act. `healnew.mjs` folds them into
`withoutTheMintsOwnNoise`; `healrevoke.mjs` mints twice and revokes once, and hands each of its four
observers only the list that observer can produce - the actor is given no refusal to forgive,
because a `401` on a client that wiped no cookie is the campaign's own session dying. Needles that go
`unmatched` are reported and forgive nothing, and two of `DEVICE_PANEL_NARRATION`'s five always are:
`Loading devices and sessions` and `N live session(s)` are already `BENIGN`, so every HEAL row
records `unmatched: 2` for a healthy panel. `classify-selftest.mjs` pins that number.

**And there is no list for the wipe's own narration, deliberately.** One was written for the three
sentences a revoked device emits before anything was asked; `NOTABLE`'s `/forget|revoke|reset|corrupt/i`
already claims all three, so they have never reached `unexplained` and the list would have forgiven
nothing while reporting three dry needles on every row of the rung forever. The four lines that
reasoning rests on are pinned in `classify-selftest.mjs`, `[RESET] N store(s) SURVIVED the wipe`
included - that one is `console.error` and breaks `clean`, which is where HEAL-REVOKE-1's open P1
would speak.

**The rig has twelve self-tests, and they run in TWO targets, because they are not one kind of thing.**
`make test-harness` is the CI gate and holds the eleven that need nothing: `rawcheck.mjs` reads every
page-side template for an escape Node eats, `classify-selftest.mjs` pins the client-side verdict
rules, `srvclassify-selftest.mjs` the server-log buckets, `logcatclassify-selftest.mjs` the phone's,
`checks-selftest.mjs` asserts that every phase in `checks.mjs` declares the devices its scripts
actually drive, `devices-selftest.mjs` pins the device panel, `debris-selftest.mjs` the allowlist that
decides what may be DELETED, `gate-selftest.mjs` the gate itself, and `ready-selftest.mjs` the preflight's readiness probe on the pages it has to tell apart - which exists because that probe is a STRING and a string is not compiled: a `\/` that should have been `\\/` emitted `/^/login/`, a SyntaxError in the page, and `node -c` was perfectly happy with it. `gate-probe-selftest.mjs` is the same job for the unlock gate - it scrapes `pin.mjs`'s own template, feeds it the shared `GATE_EXPR`, and classifies eleven pages. It pins the CLASSIFICATION too, in both directions: a client PAST the gate and one that has not reached it yet look identical to a single DOM read, and reporting the second as "no unlock modal" is what failed HEAL-NEW-0 on 2026-08-28 - while four pages that merely TALK about the PIN (`/settings`, prose anywhere, the device panel, a fresh phone's biometric offer) used to read as the gate itself. `residue-selftest.mjs` pins the border between what a native wipe must leave nothing of and what it may leave - `OUR_NATIVE` in `native-residue.mjs`, facing `KEPT_AT_TOP_LEVEL` in `src-tauri/src/commands/storage.rs` - against the real listing of a revoked Pixel 6a, because a wipe defined by what it DELETES is wrong the day the next store is added and that is how a revoked phone kept its Graine seeds. **It failed this gate on its first run**, importing `phone.mjs` for a classifier that needs no device names at all; the classifier is now its own pure module, which is the fix the gate's own error message asks for. `selector-selftest.mjs` reads every UI string this rig CLICKS - each static `text=` and `[aria-label="..."]` - and refuses one the app does not ship, because `closeOverlays` spent every run since #455 clicking `Fermer les paramètres du groupe`, a sentence that merge deleted when it folded four side panels into one. The click is wrapped in `.catch(() => {})`, so a selector that can NEVER match and one that had nothing to do are the same outcome, and the only symptom is a throw four passes later blaming the app. It needs no browser: the app's French and the rig's French are both files. `make test-harness-device` holds the one that needs a live rig,
`tabguard-selftest.mjs`, which makes W2 ambiguous on purpose to prove the tab guard refuses it - run
it by hand after editing `tabs.mjs`, `chat.mjs` or the preflight's tab repair. Run the gate after
editing `checks.mjs`, any classifier or `debris.mjs` - a phase whose `needs` disagrees with its
scripts is how MUT-18 skipped on every run it was ever asked for.

**The gate is not decoration, and it caught a live one on 2026-09-04.** Pointing the rig at a local
estate meant `psql` had to know WHICH estate, which meant reading `SITE`, which meant importing
`names.mjs` - and `ssh.mjs` is reached by `srvlog.mjs` and `devices.mjs`, so two of the eleven gated
self-tests stopped being runnable on a fresh checkout while passing perfectly here. That is the same
fault as the CD failure of `74e9e1ec` below, arrived at from the opposite direction, and the fix is
the one the gate's own message asks for: `estate.mjs` for the half that needs a machine,
`device-census.mjs` for the half that does not.

**Four were on disk and outside the gate until 2026-08-24** - `logcatclassify`, `devices`, `tabguard`
and the new `debris` - so the file said three and the Makefile ran three while six existed. A
self-test nobody runs is the plainest form of a correct mechanism with no report: it passes forever,
including on the day it would have failed. All four passed when they were added, which is the reason
this went unnoticed and not a reason it was harmless.

**AND ADDING THEM BROKE CI, WHICH IS THE REASON `gate-selftest.mjs` EXISTS.** Two of the four could
not run on a fresh checkout at all: `names.mjs` is gitignored on purpose - it holds real display names
and this repository is PUBLIC - so anything importing it, directly or three modules down, dies with
`ERR_MODULE_NOT_FOUND`. `tabguard-selftest.mjs` imports it for W2's port, and `debris-selftest.mjs`
reached it through `results.mjs`. The CD run of `74e9e1ec` failed exactly there, and it was invisible
locally because the file EXISTS here. So the marker vocabulary moved to `marker.mjs` - pure string
work has no business needing a machine to import, and `results.mjs` re-exports it so no runner
changed - the browser-driving one moved to its own target, and `gate-selftest.mjs` now reads the
Makefile recipe, walks each gated script's imports and fails if any of them is not tracked by git.
What it still cannot see is a script that imports only tracked files and needs a device anyway; only
running the gate somewhere with no rig proves that, which is what CI does on every push.

**AND THE RECORDER NOW ASKS WHETHER THE CLIENTS IT IS ABOUT TO STAMP ARE RUNNING THE DEPLOYMENT
(2026-09-24).** `record()` stamps `build` from the REPOSITORY, so a check run against a tab left
open across a deploy writes a row naming a commit whose code that tab never executed: TAB-1 came
back `FAIL` three times on 2026-09-05 against a fix its tab had never loaded, and three probes were
spent before the stale tab was the answer. `bundle.mjs` could tell a stale client from a current one
since 2026-08-24, and **only a runner ever asked it** - `tab1.mjs` learned to reload after paying
for those three rows, while `tab3b.mjs`, `tab7.mjs`, `notif.mjs`, `del1.mjs`, `msg4.mjs` and
`mut.mjs` had not. A rule living in six memories is not a rule. `recordObserved` is the one place
that knows BOTH the verdict and the clients it was observed on, so `observedBundles` puts the
question there and `gate()` makes the row **`VACUOUS` - absent, not failing**, beside
`redeployedMidRun`. **It refuses and never repairs**: TAB-7 asserts `neverReloaded`, so a recorder
that quietly reloaded a stale client would destroy the very observable some checks exist to measure
- the repair stays `bun bundle.mjs --repair`, run deliberately. A bundle that cannot be READ is a
blind spot recorded under its label, never a demotion, exactly as `deployWindow` already is. Which
clients may be judged is read off the PAGE (`location.origin === SITE`), not off a device name: the
labels runners pass to `watch()` are prose (`sender`, `receiver`, `phone`, `TAB7-W1`), and a phone
serves its shell out of the APK so its id legitimately differs. `staleness-selftest.mjs` pins all of
it.

**IT ALSO COST THE TRANSPORT ONE FACT IT WAS NOT PUBLISHING.** `ws.send` on a CLOSED socket does not
throw here - the frame goes nowhere, no reply arrives, and the caller learns from `cdp.mjs`'s 30 s
command timeout. Measured through this path on 2026-09-24: **30 002 ms for a closed client against
8 ms for a live one**, on the path of every observed row whose client had died. That is the rig's own
rule broken by its own transport, so `connect()` now returns `isOpen()` and the check reads the fact
instead of awaiting the failure - 1 ms.

**THE VERDICT VOCABULARY MOVED OUT FOR THAT REASON AND ONE OF ITS OWN (2026-09-24).**
`results.mjs` decided what a check may record - by accepting whatever string it was handed - and
`rows.mjs` held a private map of the words it could read back off the board. Nothing tied the two
together, so a runner inventing a word made the reconciler report `board: unstated` for a row the
board stated in full: a false accusation in the one report whose whole job is to be right about the
board. It happened twice, `INCONCLUSIVE` (PIN-11) and then `SETUP-FAILED` (HEAL-W2, 2026-09-06), the
second directly under a comment predicting it - a vocabulary shared by two files and owned by
neither drifts the moment a runner invents a word, and a comment is not a mechanism. Both sides now
import one frozen list from `verdicts.mjs`, which imports nothing so the gate can open it, and
`record()` REFUSES a word that is not in it rather than writing a row nobody can read.
`verdict-selftest.mjs` pins the arrangement: neither file may keep a private map, every verdict
spelled out anywhere in the rig is one the reconciler recognises, the board's older spellings
(`passed`, `failed`, `skipped`, `partial`) all land on a real verdict, and `pending` stays what it
is - the ABSENCE of a claim, never a verdict. Run against the vocabulary as it stood before either
incident, that scan names all sixteen offending call sites, which is both incidents caught in the
source on the day they were written.

## The atoms

**A GESTURE AND A ROW ARE NOT THE SAME KIND OF FILE, and until 2026-09-04 nothing in this directory
said so.** Roughly twenty files here are GESTURES - log a client in, answer the PIN, open a DM, create
a group, add a member, mint a device the server has never seen - and the other hundred-odd are ROWS
that compose gestures into a question and take a verdict. `checks.mjs` is the manifest of the second
kind; there was no index of the first, so a session picking the rig up grepped, and the third
`createGroup` got written because the first two were not findable. Three copies of one gesture is
three places for a post-condition to rot, which is exactly what `groupnav.mjs` records happening.

**AND SINCE 2026-09-04 THE SPLIT IS A DIRECTORY, not only an index.** 114 scripts moved to
[`archive/`](archive/README.md); the atoms stayed at this root. Nothing was deleted, everything still
runs, and the self-tests `make test-harness` gates live there and still pass. `ls` now answers the
question that used to need a grep. Only their imports changed - a row reaches a library that stayed
behind by `../` - and the three things that resolve script paths (`checks.mjs`'s new `scriptPath()`,
`gate-selftest.mjs`, the Makefile recipe) had to learn the rig is no longer one flat directory.

**BUT THE DIRECTORY IS NOT THE CLASSIFICATION, AND SAYING IT WAS COST 39 GESTURES THEIR FINDABILITY.**
Those 114 are not 114 rows. Measured the same day: **62 rows, 13 self-tests, and 39 gestures,
libraries and runners** - `addmember.mjs` opens *"ADDING A MEMBER TO A GROUP - one gesture"* and sat
under a heading announcing it as a question. That is the SAME failure as leaving it out of the index:
a session looking for an add-member gesture reads the atoms section, does not find it, and writes
another one. So [`INVENTORY.md`](INVENTORY.md) now files every script by **what it does** - does it
import a verdict writer from `results.mjs` - rather than by where it sits, and the partition is
asserted on every run. **Search `## Gestures, libraries and runners in archive/` before writing a
gesture**; that section is the half nobody used to look in.

**[`atoms.mjs`](atoms.mjs) is that index**, and its header is the inventory: every gesture, the file
that owns it, and what it is for. It re-exports the importable ones so a new script can reach the
whole vocabulary in one line, and `run()` is the ONE spelling of the arguments for the ones that are
still CLI scripts.

```js
import { client, createDM, login, pin, psql, SITE, startBrowser } from './atoms.mjs';
```

**Three properties define an atom, and a gesture missing one is not an atom yet.** They are not
style; each is why the campaign can be re-run by someone who was not there:

1. **It ends on a fact, never on a clock.** `createDM` returns when the sidebar names the contact,
   `login` when the app has committed to a session, `pin` when the gate is gone or an error is on
   screen. A sleep bounds a wait; it is never the wait.
2. **It is idempotent, and it reads before it acts.** Called twice, the second call is a read - so a
   row starts from whatever the previous row left behind instead of demanding a pristine estate.
3. **It addresses the product structurally, not by pixel and not by wording.** A submit button is
   `form button[type=submit]`; an autocomplete option is `[role="option"]` reached with the arrow
   keys; a tab is `APP_TAB`. **THE RIG DRIVES PHONES OF SEVERAL SIZES**, so a coordinate right on one
   screen is wrong on the next, and a French label is not an API. Where a real pointer sequence IS the
   thing under test, `realClick` re-measures the centre at the moment it clicks - adaptive, not fixed.

### Driving a phone, and WHICH phone

```sh
bun a1apk.mjs                  # build the debug APK, install it, prove the origin it points at
bun login.mjs --android        # log the phone in, end to end, with no manual probe first
bun login.mjs --device A2      # the same on the second phone
bun pin.mjs --device A1        # the encryption gate
```

**`--android` IS `--device A1`, and it arms what it needs.** It calls `phone.mjs`'s `ensure()`: wake,
launch if the process is gone, foreground it (a backgrounded WebView keeps its devtools socket listed
and then answers nothing), re-point the `adb forward` at the CURRENT pid, and report success only
once CDP has actually answered. Every one of those steps has produced a wrong verdict on its own, and
every session that hand-typed `adb forward` before calling an atom was paying for the omission.

**A SECOND PHONE MAKES `serial()` A QUESTION, AND IT NOW REFUSES TO ANSWER IT ALONE.** It used to take
the first USB entry adb listed - harmless with one phone, silently wrong with two: on 2026-09-04 a
Pixel 6a was attached beside the Mi 9T and `serial()` answered the PIXEL, so every atom would have
woken, forwarded, logged into and measured a phone the run was not about while reporting confidently
about A1. Ambiguity is an ERROR now, resolved in one of two explicit ways: `useDevice('A1')` from a
name in `SERIAL_OF`, or `ANDROID_SERIAL` - adb's own variable, which `useDevice` also sets so that
every adb this rig shells out to inherits the binding. A device name carries its platform: `W*` is a
Chrome profile, `A*` is Android.

**ON THE LOCAL ESTATE, THE APK MUST BE BUILT WITH THE LOCAL-ESTATE OVERLAY OR IT REFUSES THE ESTATE IT IS POINTED AT.**
`tauri.conf.json` names capability `default` alone, whose fetch scope is `https://**`;
`src-tauri/tauri.local.conf.json` adds `local-estate`, and `a1apk.mjs` passes it. Without it the
phone reaches the IdP, authenticates, comes back - and then shows the product's own red
`url not allowed on the configured scope: http://localhost:8081/...` under the PIN field, because
`https://**` matches port 443 and `http://**` matches port 80, neither of which is 8081. See
[`frontend/src-tauri/capabilities/local-estate.json`](../../frontend/src-tauri/capabilities/local-estate.json).

**ON DEV THE APK TAKES NEITHER THE OVERLAY NOR THE REVERSE (R2, 2026-10-24).** `a1apk.mjs` asks
`a1plan.mjs` what the estate `SITE` names needs: dev (`https://dev.canari-emse.fr`) sits inside the
default `https://**` scope and the default CSP, the phone reaches it over its radios (so `adb reverse`
is skipped and `estateReverse` is a logged no-op, and cutting the radios really takes the phone
offline), and the identity provider is dev's: `DEV_AUTHENTIK` in the machine-local `names.mjs`, the
pair the pre-release pipeline takes from its `DEV_` secrets, refused when absent. It is still a
`--debug` build, so CDP reaches the WebView. The packaged bundle - EVERY file under
`build/_app/immutable` (chunks, nodes, entry) - must name the estate AND no production origin in
any spelling (`https://`, `http://`, `wss://`, `ws://`, a bare `//`, upper case, a trailing dot).
ONE allowance, and it is scoped to a CHUNK: `publicAppUrl.ts`'s two link constants
(`DEFAULT_PUBLIC_APP_ORIGIN`, `LEGACY_PUBLIC_APP_ORIGIN`, read from that source file) as whole
string literals, inside the one chunk that also carries `PUBLIC_APP_HOSTS` - that module's own
chunk. **They were NOT always "never a request target"**: until #2385 the root layout started the
push service with `historyBaseUrl || DEFAULT_PUBLIC_APP_ORIGIN`, and `seo/site.ts` read the legacy
constant; the bundler inlined both into the layout's node, which is where the first dev build put
them. #2385 removed the fallback and made every consumer call a function of that module, so a
production literal anywhere else is a real target again and is refused. A dev APK therefore builds
only from a tree carrying #2385, and a `--ref` older than it (v1.4.0 included) is REFUSED for that
fallback - which is the right answer: that client really can call production.
**`--accept-dead-production-literal` IS THE ONE EXCEPTION, FOR THE FLOOR/OLD-CLIENT ROWS ADM-5..7
ONLY (decided 2026-10-24)**. It is never a default and nothing implies it. It is accepted only with
`--build-only --ref <tag>`, and only for a ref whose layout still carries the fallback; on any tree
carrying #2385 it is refused, since there is nothing to accept. It lets through at most ONE
occurrence of each of two compiled shapes, and every other production spelling, in every chunk,
stays refused:
- `push-service-fallback`: `.historyBaseUrl||"<canonical origin>",` (the layout before #2385).
- `legacy-apex-comparison`: `!=="<legacy origin>"?` (`seo/site.ts` before #2385 comparing the baked
  origin with the legacy apex - a comparison, never a request target).

Why the fallback may be accepted:
- A signed-in dev build always has `historyBaseUrl` set (it is the baked delivery URL), so the
  fallback is unreachable.
- The worst case is an old client sending a DEV token to production, which refuses it.
The acceptance is written into the build's `a1-builds.ndjson` record (`acceptedDeadProductionLiteral`
names each shape accepted, beside the occurrences and the ref), and a `--no-build` install of that APK is REFUSED unless `--accept-dead-production-literal` is passed again. A tag predating the
constants themselves cannot be checked at all, and `linkModuleOf` says so rather than guessing.
The build ENVIRONMENT is checked before the build: no `VITE_*` value in the process or an
unoverridden `frontend/.env*` line (`export VITE_X=` included) may name production, because the
bundle cannot tell a baked target from a constant and the environment can. A `--ref` build takes
its identity-provider pair from the MAIN checkout's machine configuration, never from the tag.
`--build-only` touches no phone, not even `adb`; `--build-only --ref <tag>` builds an OLD client in
its own detached worktree (system temp, `a1-ref-<tag>`) and keeps the APK in `STATE_DIR/apks/`.
**`--no-build` installs only an APK this rig recorded**: a Tauri APK embeds the frontend
brotli-compressed inside `lib/<abi>/libmines_app_lib.so`, so there is nothing to unzip and rescan;
instead every build appends its APK's sha256, origin and bundle verdict to `a1-builds.ndjson`, and
`installVerdict` refuses an artefact whose hash was never recorded as passing for this estate.
Installing is a deliberate gesture: an `install -r` keeps the enrolment, an uninstall costs the device.

**A Play TESTER build is recorded, never installed, by `bun a1tester.mjs --tag vX.Y.Z-alpha.N`.**
A Play-signed app cannot be replaced by the rig's APK (another signature, and no uninstall), so a
phone the tester programme moved stays there, and `pin.mjs` refuses an app no record vouches for.
`a1tester.mjs` reads the facts where they live: the installed versionName/versionCode from `dumpsys`,
the running bundle's stamp from the app, and the release, its Android job and that job's log from
GitHub. `testerbuild.mjs` (pinned by `archive/testerbuild-selftest.mjs`) accepts only when all of
these hold:
- the tag is a pre-release;
- its Android job succeeded and printed `Android build targets dev`;
- the phone's bundle names the commit that job checked out and was built inside the job's window;
- the versionName is the tag's.
On acceptance it appends `source: 'play-tester'` to `a1-builds.ndjson`. Its `bundleOk: true` is INHERITED from
the job log's dev line, not from a bundle grep: a release APK embeds its bundle compressed, so the
rig cannot rescan it, and `android.yml` refused anything but dev before printing that line. A STABLE (a production build)
is refused first, an unknown build stays `unrecorded`, and a tester record carries no APK sha, so it
never authorises a `--no-build` install.

**An atom takes no verdict**, writes nothing to `results.ndjson` and asserts nothing about the
application. That is what makes it reusable: a row decides what an outcome MEANS, and two rows may
read the same outcome differently.

**What is deliberately NOT done here.** Half the atoms are importable functions and half are CLI
scripts with top-level `await`, reached by spawning. Converting the second half into functions with a
thin CLI wrapper is worth doing and changes the process model of every runner that spawns them - so
it belongs in its own change rather than riding along with a defect fix. `run()` exists so that in the
meantime no caller re-derives the argument spelling, and `pin`'s exit 2 ("no gate on screen") is
documented there as an ANSWER rather than a failure, because that is the distinction each private copy
used to get wrong on its own.

## The files

> **[`INVENTORY.md`](INVENTORY.md) IS THE COMPLETE, GENERATED LIST - read it first, and read it
> before writing any new script.** It is derived from the leading docblock of all 156 scripts by
> `bun inventory.mjs`, and `make test-harness` fails when it and the tree disagree, so it cannot go
> stale. **This section is the PROSE it cannot carry** - why files are grouped as they are, and what
> a group is for. It was the inventory until 2026-09-04, and measuring it is what ended that: it
> named 88 of 155 scripts, missed four atoms entirely, left 69 archived scripts undocumented, and
> pointed 45 references at a root the files had just left. An index in that state does not fail to
> help, it sends the reader to write the thing again - which is exactly what kept happening.
>
> **A name below without a directory may live in [`archive/`](archive/README.md).** `INVENTORY.md`
> says which, for every one of them.


**The library** - everything else imports these.

| File | Role |
| ---- | ---- |
| `atoms.mjs` | **The index of the gestures**, and the only file here that is documentation first: what each atom is, the three properties one has to have, and `run()` - the single spelling of the arguments for the atoms that are still CLI scripts. Imports nothing machine-local of its own; re-exports the importable primitives so a new script reaches the whole vocabulary in one line. |
| `cdp.mjs` | The whole CDP client: targets, `evaluate`, `stableCentreOf`, `clickAtPoint`, `realClick`, `dragTo`, `holdAndSlide`, `until`, focus emulation. **`holdAndSlide` is the one that can hold**: it slides a DISTANCE rather than to another element - a threshold has no node to name - and `release: false` leaves the pointer down, which is the only way to read a state that exists solely while a finger is on the glass. Measure over the same connection when you use it: closing one resets the browser's touch state and the next move is refused. |
| `chat.mjs` | Chat primitives shared by every check - `client`, `ensureChat`, `openConversation`, `send`, `clickBubbleAction`. The single definition of "a message arrived", so two checks cannot disagree for harness reasons. |
| `watch.mjs` | Continuous observation: console, page errors, HTTP, WebSocket. Attached by every runner. |
| `srvlog.mjs` | The server observer, held to the same bar as the two clients: the whole window is classified, and it partitions by SUBJECT because production is shared. |
| `deploy.mjs` | Whether the estate was REDEPLOYED or RESTARTED under the run - the one cause of transport failure that is ours. Local: a container of the compose project started inside the window. Dev (R4): the CONFIGURED estate decides (the origin `site.mjs` registers), never a report's origin, and local docker is never asked about a dev run. Five witnesses: the build `/api/version` serves at each window's start (`watch()`, native clients included) against the build at `gate()`; windows that opened on different builds; any `release.yml` run whose TAG (`headBranch`) is not a stable version intersecting the window (a rerun of the same tag changes no build); a dev container that started or stopped in the window (`StartedAt` / `FinishedAt`, stopped containers included, the window widened by 5 s for the host clock), read over the dev ssh route in a child process; and a `dev-reset` dispatch of `scheduled.yml` whose reset job did not skip (the seed is restored with no build). The preflight waits for a release in flight and names dev's build; `gate()` turns an overlap into VACUOUS, never FAIL. An unreadable witness is a recorded blind spot - locally the verdict stands, ON DEV IT IS VACUOUS, never PASS. **No pre-release is cut while a campaign session is open** - the gate voids the rows it would hit, it cannot stop the gesture. |
| `bundle.mjs` | Which bundle a client is actually EXECUTING, and the reload that fixes it - the other half of `deploy.mjs`'s question. A browser open across a deploy keeps the old code and looks identical to a fresh one, so the preflight compares `__sveltekit_<id>` in the page against the shell the origin serves. The web/phone split comes from `ORIGIN[device] === SITE`, because an APK is never on the deployment. |
| `unread-communities.mjs` | **THE TEN-COMMUNITY UNREAD SCENARIO** - `setup --n 10` (communities, salons, the reader joins), then `run arrive|walk|gatewaydown|open|mobile`. Every step is read on THREE ends: the sidebar (rail dot, badge per salon), the server's `channel_members."readMarks"` against the newest message, and nginx's access log of the read endpoints. Built to answer "messages are marked read though I never opened the salon" (2026-10-08): nothing was marked, the badge was a live tally that a reload erased - [chat](../../docs/wiki/frontend/modules/chat.md#unread-counts-of-salons-the-server-counts-this-device-only-merges-2026-10-08). Local estate only; W1 posts, W2 reads. |
| `sweep.mjs` | **DOES EVERY PAGE FIT, ON A CLIENT THAT IS ACTUALLY RENDERING** - `bun sweep.mjs --device A1`, or `--route /calendar` while fixing one. Three measurements per route, and they are not one question: whether the DOCUMENT scrolls sideways, whether any ELEMENT sticks out past the viewport (it can, without the document scrolling, because an ancestor clips it - the shape three of the four 2026-09-14 defects had), and which text is clipped by its own box. The last is printed as a READING and never failed on: a title ending in an ellipsis in a narrow bar is correct, and only a reader can say which truncation is a defect. Routes are reached by clicking an injected anchor, which is what a user does and what the router is written for; a hard navigation per route would re-boot the WASM client fifty times and measure a first paint instead of a page. A route a link cannot reach is reported UNREACHED, never worked around. |
| `comm.mjs` | Community and salon gestures, and the panels behind them - `openChannelSettings` and `openChannelAccess` share one modal-open, `setChannelNotifLevel` reads the radio group's `aria-checked` rather than a styling class. |
| `grainedb.mjs` | The questions a SCREEN cannot answer, asked of production's database: what a device is routed, what sessions a salon holds, what notification level a member stored, what order a member put their communities in. Read-only, always. |
| `identity.mjs` | **WHICH ACCOUNT A CLIENT IS ACTUALLY ACTING AS**, and the answer no check could give before 2026-09-09. `bun identity.mjs` reads every client in `PORTS`; `--device W2` reads one. It asks TWO questions on purpose - what the client SHOWS (`canari_saved_user`, written by the app at login) and what it ACTS AS (the `sub` of its access token) - because the false P1 that day claimed exactly that they could disagree. **It costs no traffic and no reload**: the access token is published by the app itself into the JS-readable `canari_ws_token` cookie, so it is read where the app already put it rather than by watching nine seconds of traffic after a reload, which is what the first version did. Exits non-zero when a reachable client is not its owner. |
| `subject.mjs` | The pure half of the above - `subjectOfToken`, `nameSubject`, `describeIdentity`, `wrongIdentities`. Split for the same reason as `device-census.mjs`, `native-residue.mjs` and `usability.mjs`: `identity-selftest.mjs` is in the CI gate, and deciding what a subject MEANS needs no browser and no `names.mjs`. An unreadable half is never an agreement, so a client with no token yet reads `agrees: false` rather than passing quietly. |
| `names.mjs` / `accounts.mjs` | The only two readers of machine-local truth. Every other file goes through them. **`accounts.mjs` holds THREE strings for one human and they are not interchangeable**: `username` fills a LOGIN FORM, `OWNER_NAME`/`PEER_NAME` in `names.mjs` match a MEMBER PICKER, and `subjectFor(key)` is the only one the SERVER decides by. Two of the three have already been used as the third - the display name did it on 2026-09-09 and produced a P1 that declared every two-client measurement void. |
| `estate.mjs` | `psql`, `redis` and the server log window, aimed at whichever estate `SITE` names - local `docker exec` or dev's containers by compose label - with no flag, no fallback and no production branch (*The target*). **Its own module rather than two more exports in `ssh.mjs`**, because reading `SITE` means importing `names.mjs`, which is gitignored: putting them there made `srvlog.mjs` and `devices.mjs` unimportable on a fresh checkout and `gate-selftest.mjs` failed within the hour. A transport is machine-agnostic; an estate is not. |
| `device-census.mjs` | The pure half of `devices.mjs` - the census SQL text and every function that turns a row into a fact. Split for the same reason as `native-residue.mjs`, `servable.mjs`, `usability.mjs` and `marker.mjs`: `devices-selftest.mjs` is in the CI gate, and deciding what a row MEANS needs no machine. |
| `phone.mjs` | adb, app lifecycle, notifications, the WebView - and the only entry point for the devtools forward. Also the NATIVE half of what a device holds: `nativeFootprint()` for a byte total, and `nativeResidue()` for the part that is a criterion - WHICH of Canari's own paths are still under `/data/data/<pkg>` (`mls.bin`, `canari_<userId>.db`, `graine_seeds.json`, `channel_keys.json`, the `avatar_*` cache, `shared_prefs/canari_*`, `keystore_aliases`). Its `OUR_NATIVE` faces `KEPT_AT_TOP_LEVEL` in `src-tauri/src/commands/storage.rs`: that says what the wipe must not touch, this says what must be gone after it. Prefer it to the byte total, which read 19 MB with the account gone and 31 MB with it present on the same device inside an hour. Ids are cut to eight characters, and `logs/` is reported under `rewritten` rather than counted - the running app recreates it in milliseconds. Needs a DEBUGGABLE build (`run-as`). |
| `login.mjs`, `pin.mjs`, `unlock.mjs` | The auth gates. `unlock.mjs` unlocks every client it can identify. `login.mjs` ends its wait on EITHER the app's own form or a CAS form in the phone's **Chrome Custom Tab** (`--tabPort`, default `port + 1`), fills whichever holds it with one copy of the code, and reads the landing by RE-RESOLVING the app's target - Android may have killed the WebView while the tab was in front. **It ends on the SESSION, never on a clock**: it polls `canari_saved_user` until the app writes it, and on reaching its 30 s reporting bound it names which of the three states it saw - the exchange still running (SLOW), the app back with nothing written (REFUSED), or the browser never back at all (the deep link or the IdP). Until 2026-09-24 those three shared one message, and a login that had succeeded was reported as one that had not. |
| `gate-probe.mjs` | `GATE_EXPR`, the ONE expression answering "is the encryption PIN gate on screen", imported by `pin.mjs`, `pingate.mjs` and `state.mjs`. It had three copies keyed partly on body text, and `/settings` names the gate in its own security section - so a client parked there read `LOCKED` while perfectly unlocked, and `settle()` returns `LOCKED` to four runners that then produce no verdict. A gate is a MODAL: `role=dialog` plus its `aria-label`. |
| `pingate.mjs` | The PIN gate as a LIBRARY, for a check that has to re-unlock mid-run. `unlockClient` types the PIN and then RE-READS the client to say whether it got through - see below. |
| `phone.mjs` | The device, as a check sees it - and `forwardIdpBrowser`, which finds the browser holding the identity-provider page instead of assuming Chrome. This phone is LineageOS and the OIDC hop lands in `org.lineageos.jelly`; the forward `login.mjs` needed had never been created at all, so every phone login typed nothing and showed only "Redirection...". |
| `net.mjs` | The radios. `armCut`/`cutHard` exist because CDP offline emulation leaves an already-established WebSocket alone - the plain cut could never produce a receiver-side disconnection, so MSG-9 had never once measured the thing it was named for. |
| `fault.mjs` | **The response-stage fault (R3, 2026-10-24)**: over CDP `Fetch`, per URL substring/RegExp and method, `lose-answer` (the server ran it, the page sees a transport failure - the case commit settlement exists for), `status N` (the server ran it, the page sees N), `status-unsent N` (the server never saw it), `delay MS`, `hold` (stopped before the server, `release()` lets two clients' commits go together) and `hold-answer` (the server ran it, the page waits); each with `once`/`xN`. Every action is recorded with its CDP `requestId`/`networkId`, method, URL, the real status and timestamps, so a row can join it to the server's log line; `disarm()` reports a rule that never fired as `vacuous`. A dedicated Worker's fetch IS intercepted (measured). `archive/fault-selftest.mjs` (CI) drives it against a stub connection; `archive/fault-live-selftest.mjs` (`make test-harness-device`) measures every mode from both ends against a throwaway server and a headless Chrome on a temporary profile - no estate. |
| `a1.py` | Native Android surfaces via `uiautomator2`, for what the WebView cannot see. |
| `a1apk.mjs` | **The A1 build, install and reverse, as one gesture** - and the assertions that each happened. The SDK and the NDK are DISCOVERED (the README's hardcoded `ndk/26.1.10909125` had rotted), `BUILD_WEB` is deleted from the child environment so Tauri gets its adapter-static shape, the seven `VITE_*_URL` travel as environment rather than an edit to the shared `frontend/.env`, and the packaged bundle is grepped for `SITE` - an APK silently pointing at production fails a row for a reason nobody can see. Importable as `armA1`. |
| `syncrows.mjs` | The sidebar's readiness, read off `data-ready` / `data-removed` on `[data-conversation-tile]` and NEVER off the translated "Sync" badge - plus `whoAmI`, `navigationCost` and the server-side counterpart (`active`, `tombstoned`, `dismissed`, `dismissedStillMember`). Every HEAL row's numbers come from here, which is why one gate before the rung asks whether the hook is in the SERVED artefact. |
| `usability.mjs` | The two tile targets and the two answer predicates that decide HEAL-NEW-15 - `OPENED` for a ready row (the list selects it AND the conversation renders), `REACTED` for a syncing one (the list may not stay unmoved, but the app may decline to render a group it holds no MLS state for). Split out of `syncrows.mjs` for the reason `servable.mjs` was: a self-test in the CI gate cannot reach `names.mjs`. `usability-selftest.mjs` pins both faults that produce a NUMBER rather than an error - a composer that was already on the page, and a click on the conversation already open. |
| `newdevice.mjs` | The device-minting primitive, and HEAL-NEW-0 when run directly. Wipes one browser's origin to factory, brings the same account back, and asserts the server has never seen the id that comes out. Eleven rows import it rather than re-mint, and `--keep-open` is why it is a module. |
| `serverwindow.mjs` | The server as the THIRD observer of a gated row. A runner that sets `serverWindowSince` gets `recordObserved` to take the server window, fold it into `clean` (so a dirty server demotes a PASS exactly as a dirty client does), and write `serverWindow`, `serverClean` and `dirt_server` to the ledger. A record WITHOUT `serverClean` never observed the server, and `bun rows.mjs` lists those HEAL rows by name rather than counting them green. `healnew.mjs` and `healrevoke.mjs` opt in. |
| `roster.mjs` | MULTI-7/8/9/10 - the four rows that read `dm_device_group_memberships` instead of a screen. Every query is a READ. Its venue is the owner-peer CONVERSATION resolved by membership, not a community channel: a channel's distribution group is workspace-scoped and carries no `dm_group_members` at all. |
| `healnew.mjs` | HEAL-NEW-1/2/3/11/12/15 - one runner, rows as data, so the order pairs (3 vs 11, 2 vs 12) run the same code with `respondersAt` moved and a difference between them is the app's. Kills a responder rather than navigating it away, stops the PHONE for every row, and records a comparable `finalState` fingerprint. |
| `healrevoke.mjs` | HEAL-REVOKE-5/7/8 - a revoked device that missed a great deal and comes back. Mints an enrolled W3, revokes it with the census as proof, moves the world, brings it back WITHOUT a wipe so a survivor would show, then mints a fresh reference device in the same world and asserts the two states differ in nothing. |
| `footprint.mjs` | What a device still HOLDS, read off the device rather than out of its own log - the WebView's localStorage, sessionStorage, `CanariDB*` count, identity keys, response caches and bytes in use. `bun footprint.mjs --device W1`. Counts only, never names: a surviving key is `mls_not_ready_since:<userId>:<groupId>` and this output reaches a PUBLIC repo. **Two criteria** (`nothingOfTheAccountRemains`): the `CanariDB*` count AND `identityKeys`, being `mls_device_id_<userId>` plus `canari_device_key_vault`. The database count alone is NOT enough - on a Tauri client the message store is native SQLite, so it reads 0 on an enrolled phone too, and this tool answered "nothing of the account remains" about an A1 displaying eleven conversations. The other counts are evidence beside them: an empty app rewrites a locale key and re-caches its shell the moment it is looked at, so asserting those at zero fails a correct wipe for having been observed. **The verdict is `deviceResidue(label, cx)`, exported, and that is what a runner must assert on** - for a `tauri` origin it is the AND of both halves, the native one from `nativeResidue()` below, and a native half that cannot be read VOIDS the verdict instead of passing it. `nothingOfTheAccountRemains` is the WEB half alone and must not be called about a device that might be a phone; the pure combiner is `residueVerdict` in `native-residue.mjs`, pinned by `residue-selftest.mjs`. |
| `native-residue.mjs` | The pure half of the native criterion: `OUR_NATIVE`, the paths that exist only because an account was signed in on this phone, and `REWRITTEN_WHILE_RUNNING`, the ones a live app recreates in milliseconds. Its own module so `residue-selftest.mjs` runs on a fresh checkout - deciding what a path MEANS needs no device and no `names.mjs`. |

**Checks** - `msg*` `type` `read` `mut` `search` `mention` `fwd*` `grp-traffic` `del1` `tab*` `life`
`notif*` `heal*` for the campaign phases, named after the dashboard rows they answer.

**Two gestures were private to one check each until 2026-08-21, and both were wrong about the same
thing.** `mention.mjs` carried its own notification-level setter that recognised the selected button
by `border-amber-500`, a Tailwind class - the only signal that existed, and one no restyling would
have survived; and its own mention-composer gesture, which COMM-14 needed too. Both now live where
they belong (`comm.mjs`, `chat.mjs`), and the setter reads `aria-checked`, which the app grew the
same day precisely because a screen reader had no way to hear which level was in force either.

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

**Tools** - `launch.mjs` `reload.mjs` `bundle-id.mjs` `cleanup.mjs` `dismiss.mjs` `shot.mjs` `navstack.mjs` `state.mjs` `results.mjs` `verdicts.mjs`

`navstack.mjs` reads what the BACK button has left to go back to - `location.pathname`,
`history.length` and the top entry's own state - which no screenshot and no log can give:
"Back exits the app" and "Back steps to the list" draw the same artefacts. It writes nothing,
so it is safe to run mid-check.
operate the rig; `purge-devices.mjs` drives the real device panel (not the database); `ladder.mjs` `wsidle.mjs`
`navclose.mjs` `synboot.mjs` `synopen.mjs` `synwatch.mjs` `ckpt.mjs` `burn.mjs` are the probes that
took a specific measurement and were kept because the measurement is repeatable.

**A DELETED GROUP IS TWO ESTATES, AND THE SWEEP OF ONE IS NOT THE SWEEP OF THE OTHER.** `cleanup.mjs`
deletes the group; `dismiss.mjs` clears the copy each MEMBER'S CLIENT keeps afterwards, because the
product deliberately keeps it - the conversation is marked `removed` and shown with a banner
"instead of removing it silently", and only its owner may clear it. So the two sweeps look identical
and are not: W1, which creates and then deletes, was measured **clean** on 2026-08-24 while W2, which
is only a member, held **189** rows from the GRP phase alone. They share ONE allowlist (`debris.mjs`),
and `dismiss.mjs` refuses to dismiss a group whose server row is still alive - a local dismissal there
would hide it from this device while every other member kept theirs, which is not cleaning up.

**THE SWEEP IS NOT A GESTURE ANY MORE.** `run.mjs` calls `sweepDismissed` on every client it drove at
the end of every pass, so a pass's debris is gone before the next one starts. It is deliberately NOT
the phase's job, and the reason is the one `dismissOverlay` already carries: the runs that need a
teardown are the ones that DIED, and a script that throws never reaches its own last line - `finish`
compounds it by exiting on the verdict. `grp.mjs` does delete its groups, in a `finally`, and still
left 189 rows. So the phase DECLARES, through `debris.mjs`, and the process no script can crash
EXECUTES. It is unconditional rather than opted into per phase, because a flag is one more thing to
keep in sync and would be wrong the first time a phase nobody thought about creates a group - DEL,
HEAL and MULTI all do. With nothing to clear it costs one store read per client and makes no request.
The SERVER half stays manual: `cleanup.mjs` deletes live groups and generates real traffic, which is a
decision about the estate rather than a tidy-up of one pass, and a row the sweep must spare because
its group is still alive is printed by name so the gesture that is owed is never inferred.

**AND IT NOW SAYS WHAT IT DOES NOT LOOK AT.** `cleanup.mjs` owns three stores - communities, salons,
groups - and its "nothing to sweep" used to read as "the estate is clean" while a delivery queue of
13 275 rows sat beside it (2026-09-08). Every run now prints the stores outside its scope with a
LIVE count, so the size is visible rather than asserted: `queued_message`, whose rows belong to
devices no table here enumerates and which expire on their own after 90 days, and `associations`,
which holds check R's notification fixture and is equipment rather than debris. **Neither is a sweep
waiting to be written** - re-measured 2026-09-24 the queue held 4 rows from ONE LIVE device, so a
clause would destroy undelivered messages to buy nothing.

**AND IT NAVIGATES NOTHING, ON ANY DEVICE.** A1 had to be swept as it was left, because `goto` there
re-locks the PIN and replaces the document under Tauri's IPC - which PROVED the sweep needs no
navigation, since the phone was swept without one. W1 and W2 kept a `navigate` on their first row
anyway, and it cost exactly what A1's comment predicted: the user found W2 sitting on the PIN modal
on 2026-08-24, put there by the sweep's own reload. A reload the phone may not have and the desktops
do not need is not a device difference, it is a leftover. All three now read `location.pathname` and
say so out loud if the client is somewhere other than `/chat`.

The 189 also measured the allowlist itself: 22 were `GRP5-<mark>-R`, from the rename GRP-5 performs,
and the pattern matched neither them nor the tombstones they leave. The server-side sweep would
equally have spared a LIVE `GRP5-*-R`. Widen such a list by ENUMERATING what the runners mint -
`grep -n renameGroup *.mjs` is the whole enumeration - never by relaxing a shape until it fits.

Three exist because a run once measured something other than what it claimed to, and each closes that
hole with an assertion rather than a habit:

- **`bundle-id.mjs` - the diagnostic; THE PREFLIGHT IS THE GATE.** "Reload the browsers onto the new
  build" was a rule for days with nothing behind it, and a reload served from cache is
  indistinguishable from one that was not. SvelteKit stamps a per-build `__sveltekit_<id>` as a
  global, so the running page carries its build id while the origin serves the current one: comparing
  them turns the rule into a check that exits non-zero. **A navigation does not pick up a deploy -
  only `Page.reload {ignoreCache:true}` does.**

  Until 2026-08-24 this file and `reload.mjs` each held their own copy of that comparison and neither
  had a caller - the rule was enforced by remembering to type one of them. `run.mjs`'s preflight now
  asks it before EVERY job, reloads a stale client and refuses to measure one that will not move, so
  running this by hand is a diagnostic rather than the protection. The comparison and the repair both
  live in `bundle.mjs`, shared by all three. Rule 36 of
  [testing-methodology](../../docs/wiki/testing-methodology.md) carries the run this cost.
- **`ssh.mjs` - the single door to a remote host, used by `estate.mjs` for dev alone.** `ssh` resolves to **Git's** binary under Bash, which
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
  **IT WAS ON DISK AND IN NO TARGET UNTIL 2026-08-26**, and on that day it was carrying two live
  findings nobody had read: `groupnav.mjs`'s overlay probe, and `del1.mjs`'s history probe - which it
  could not even see, because its opener was matched as `(function (` alone and that template opens
  `(async function () {`. So DEL-1 asked the page for `Cette conversation a ete supprimee.` inside a
  body where every letter `s` had been replaced by a space, could never find it, and recorded a
  product FAIL that was entirely its own. It is now the first line of the gate, it scans its OWN
  directory rather than the CWD - run from the repository root it used to find nothing and say
  `clean` - and its opener matches `async` too.

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

- **`reload.mjs`** is the operator's entry point to the repair `bundle.mjs` performs: it reloads past
  the cache and re-asserts the build id rather than assuming the reload took. Run through `run.mjs`
  the preflight does this itself, and puts the PIN gate back down afterwards - by hand, `pin.mjs` is
  owed straight after, which is why the command says so on its last line.
- **`bundle.mjs`** is the one implementation of "which bundle is this client running", and it takes
  the web/phone split from `ORIGIN[device] === SITE` instead of a device-name list of its own. The
  phone is never on the deployment, so its build is read from its own APK asset; a browser's has to be
  compared against what the origin serves, because pointing at production is not running it.
- **`sourceIsDeployed` (in `bundle.mjs`) asks the third question, and it is the one that was
  missing**: a client matching the deployment and a deployment matching itself say nothing about the
  SOURCE that build was made from. On 2026-09-07 a background `vite build` overlapped a `git switch`,
  the artefact came out without `data-remove-member`, and GRP-3 and GRP-8 failed accusing the product
  of it while every existing check passed. The build now writes `{id, sha}` into
  `frontend/build/source-stamp.json` (`frontend/scripts/source-stamp.mjs`, called by
  `check-bundle-consistency.mjs`), the preflight compares both halves, and a disagreement is a
  refusal naming `make local-frontend` - LOCAL only, since production legitimately lags the tree.
  **The operational half has no code: nothing may move the working tree while a build is running.**
- **`unlock.mjs`** resolves which account owns which port from `test-accounts.json`, navigates to a
  route where the gate actually MOUNTS, and spawns `pin.mjs` - so the recurring "you forgot the PIN"
  costs one idempotent command, and no real first name is typed into a shell line.
- **`pingate.mjs` is that same gate for a check that has to re-unlock in the MIDDLE of a run**, and
  it exists because five runners had each grown a private `unlock()` that spawned `pin.mjs` and kept
  **its last line of stdout**. A string is not a post-condition: `pin.mjs failed: …` and `[pin]
  unlocked` are both truthy, both were recorded beside the verdict instead of gating it, and the run
  carried on either way - into a client that renders, answers every probe and reports on an EMPTY
  store, so the next assertion reads zero of everything and the check blames the application for the
  harness's own locked browser. `unlockClient` re-reads the client afterwards and returns
  `unlocked` / `LOCKED` / `UNDECIDED`; a caller that gets anything but the first has an UNASKABLE
  question, not a failing one. **`comm22.mjs` uses it; `life.mjs`, `notif.mjs`, `notif7.mjs` and
  `tab236.mjs` still hold the old shape** and are converted when the LIFE, NOTIF and TAB phases run,
  where the change can be validated on the spot rather than four rungs ahead of any evidence.
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

**A STALE `uiautomator` SERVER MAKES EVERY SHADE READ FAIL, AND IT SAYS SO AS `attempt 33`.** A
`uiautomator dump` that was interrupted leaves its `app_process` running under the `shell` user,
holding UiAutomation - and the next dump is SIGKILLed rather than refused, so the caller sees exit
137 and an empty stdout. The rig retries, 33 times, then records `SETUP-FAILED`; on 2026-09-22 that
cost NOTIF-7 and NOTIF-7b one run each, on a pass where the notification had in fact arrived AND
decrypted in both modes. Nothing in the message names the cause, and the on-device dump file is
still there with a THREE-WEEK-OLD mtime, which is the tell:

```sh
adb shell "ps -A | grep app_process"   # a `shell`-owned one parked in futex_wait is the culprit
adb shell kill -9 <pid>                # the next dump succeeds immediately
```

It is not the lockscreen, which is the other thing that stops a dump: `mWakefulness=Awake` and
`mDreamingLockscreen=false` were both true throughout. Check the leftover process FIRST - the lock
is visible in one command and this is not.

**Bringing A1 back from zero** - HEAL does this repeatedly, and every step below was learnt by it
failing once. The whole sequence is scripted; it is written out because when one step misbehaves the
next one's symptom names the wrong cause.

1. `adb devices` must list it. An empty list here is the CABLE - the `A1_WIFI` fallback needs a prior
   `adb tcpip 5555` it does not have.
2. `bun phone.mjs 9333` (ONE positional port, not `--ensure`). It forwards the app's WebView on
   9333 **and Chrome's own on 9334** - both are needed, because the login is not in the app.
3. `bun login.mjs --device A1`. Idempotent: a device the IdP still knows reports `already
   authenticated` and fills nothing. When CAS's cookie has expired the form appears in the Custom
   Tab, and this fills it there. **The app's WebView may die during the hop** - that is not a
   failure, and the landing is re-resolved.
4. `bun pin.mjs --device A1`. Required after ANY relaunch, kill, reboot, radio cycle or
   `install -r`.
5. The biometric offer is answered with **Plus tard**, by `clearOverlays` and by `pin.mjs`. Never
   "Activer": it erases the PIN, and the PIN is the only credential this rig can present.
6. `bun state.mjs` and `bun identity.mjs --device A1` to prove it - a path, a sidebar, a device id
   and the right user. `LOCKED` on a route that merely mentions the PIN is no longer possible, but a
   client with no sidebar and no dialog on `/settings` is simply on `/settings`.

**The browsers**

- **Reload W1 and W2 onto the CURRENT bundle before any repair check.** A client left open across a
  deploy is running yesterday's code, and every line it logs will be read as though it were not.
- **`connect()` in `cdp.mjs` is not ready-aware.** Use `client(port)` from `chat.mjs`, which waits
  for the page. (Cost two runs.)
- A relaunch keeps the login but **re-locks the PIN**, and so do a kill, a reboot, a radio cycle and
  an `install -r`.
- Two isolated browser contexts are two devices; never assert a wall clock in a check.

**The phone**

- The WebView pid changes on every cold start, so redo the forward with `bun phone.mjs`. **The socket
  exists only once the WebView does**: a process started by a broadcast has neither a window nor a
  devtools socket (see WP-DIRECTBOOT-1), so poll for the socket rather than concluding the app is not
  running - and a stale forward does not error, it connects to nothing.
- Both transports attached means **every `adb` call needs `-s`**.
- **`run-as <pkg>` reaches the app's private files** on a debug build, which is how a cache is emptied
  to force a code path that would otherwise be skipped. One of the few things a debug build is better
  for.
- **Use PowerShell for any `adb shell` command carrying an absolute device path** - Git Bash rewrites
  `/sdcard/x` into a Windows-ish path and the command silently targets nothing.
- On a DEBUG build the phone's entire web console is in logcat under `Tauri/Console` (wry's
  `onConsoleMessage`, gated on `BuildConfig.DEBUG`; a release build logs no JavaScript). Capture continuously to a file:
  a busy device overruns the ring buffer in minutes.
- **The phone does not pick up a deploy at all**: `frontendDist` is `../build`, so it serves the
  bundle inside its APK. Verifying a UI change there means building and installing one.

**Building for it**

- **`bun a1apk.mjs` IS THE GESTURE, and nothing below should be retyped.** Reverse, build, install,
  and the assertions that each of those actually happened - one command, because the next campaign
  needs the APK rebuilt several times and an invocation spelt in prose is one nobody re-measures.
  `--no-build` installs what is already on disk; `--reverse` alone is what a replug costs. It is a
  MODULE too (`armA1`), so a phase that arms the phone calls it instead of shelling out.

  **`adb reverse --remove` DOES NOT CUT AN OPEN WEBSOCKET, so it cannot simulate a stream gap**
  (LIFE-6 measured it on 2026-09-07, the Mi 9T pass's D5 met it again on 2026-10-06): it closes the
  listener and the socket the app already holds keeps delivering. A gap is made by `restartGateway()`
  in `estate.mjs` - `docker restart canari-local-chat-gateway-1`, which worked for D1 - and it throws
  on any estate but the local one.

- **Hand-made throwaway groups use `bun newgroup.mjs --sandbox <TAG>`**, which mints `SBX<TAG>-<mark>`,
  a shape `debris.mjs` allowlists. A group made with `--name` (`ORD7496`, `ORE0185` on 2026-10-06) is a
  person's name and is deliberately never swept: no runner mints it, and a three-letters-four-digits
  pattern is one a person types. The allowlist was not widened; `debris-selftest.mjs` pins both names
  as SPARED.
- **`closeOverlays` closes the "Ajouter des membres" modal by its backdrop's own control**
  (`MODAL_CLOSE` in `groupnav.mjs`), pinned against `Modal.svelte` by `selector-selftest.mjs`, and
  `grp.mjs`'s `addPeer` throws, naming the reason, when the picker returns no candidate.

  **Two flags exist for check R and for nothing else.** `--release` builds the MINIFIED,
  resource-shrunk variant - the only one in which a stripped class or resource can surface - and
  installing it **costs the device**: it is signed with another key, so the tool uninstalls the
  debug build first, deliberately and loudly, rather than meeting a refusal it cannot honour.
  `--build-only` stops after the build and its assertions and touches no phone, because the
  questions that matter most are asked of the ARTIFACT: what a shipped library compiles was settled
  by counting a string in it against a control, and a runtime probe on a development ROM could
  corroborate neither half ([device-verification](../../docs/wiki/device-verification.md#r-the-shrunk-release-apk-actually-runs---owed-on-android)).

  **Everything it needs is DISCOVERED, which is why the paragraph below went stale.** The SDK comes
  from `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `%LOCALAPPDATA%/Android/Sdk`; the NDK is the
  highest version present under it. The line here used to name `ndk/26.1.10909125`, and this
  workstation has `29.0.13846066` and nothing else.

  **And it asserts the three things a wrong APK would hide.** `BUILD_WEB` is deleted from the child
  environment (Tauri needs adapter-static, and a shell that has just deployed the local estate has it
  set); the seven `VITE_*_URL` are passed as environment rather than written into `frontend/.env`,
  which `bun run dev` shares and needs same-origin; and the packaged bundle is then GREPPED for
  `SITE`, because an APK silently pointing at production fails a row for a reason nobody can see.

- **A1 MUST STAY A `--debug` BUILD (local or dev), and the CI artefact cannot replace it (measured
  2026-08-28).** The pipeline produces a RELEASE APK: not debuggable, and signed with the release
  keystore, so `adb install -r` fails on the signature mismatch and the only way through would be an
  uninstall - which destroys the very data a footprint row measures. And **`run-as` needs
  debuggable**, while `run-as` IS the native half of the footprint, the half that found two P1s.
  **What this bullet also claimed - that a debug build is the ONLY one that can reach the local
  estate - is FALSE, and the config it cited is what refutes it (2026-09-24).**
  `usesCleartextTraffic=true` is set for the debug type alone, but that attribute is only the BASE
  config; `network_security_config.xml` sits in `src/main/res`, applies to every build type, and
  names `tauri.localhost` and `localhost` in a `domain-config` that overrides the base for them.
  Read off the release ARTIFACT, not argued: `aapt2 dump xmltree` on `app-universal-release.apk`
  gives `cleartextTrafficPermitted=true` over both domains, from a resource the shrinker renamed to
  `res/8G.xml` and kept. What a release build genuinely lacks is the Tauri CAPABILITY scope, and
  `--config src-tauri/tauri.local.conf.json` gives it to either build type - which is how
  `--release` builds a check-R artifact for this estate. The upgrade KEEPS the app data - verified, 355 bytes of drift, and again
  2026-09-04 going from 0.5.0 to 0.16.3. **Do not pipe that build to `tail`**: the output is buffered
  until exit, so all progress visibility is lost. Redirect instead, and read `cargo` / `rustc` in the
  process list to tell a running build from a stalled one.
- `./node_modules/.bin/tauri.exe android build --debug` from `frontend/`, then
  `adb install -r .../apk/universal/debug/app-universal-debug.apk` - **not** `arm64/`, which is
  stale. Three details, each of which has cost a session:
  - **`npx tauri` does not resolve on this box** (`could not determine executable to run`), and
    `bun tauri` shells out the same way. Call the binary in `node_modules/.bin` directly.
  - **`install -r`, never an uninstall.** It keeps the app data, which is the enrolment and the MLS
    store; an uninstall costs a re-enrolment. **That is no longer a 2FA** - since 2026-09-02 the
    test accounts sign in without a second factor - but it is still a new DEVICE,
    with no history for any HEAL row to reason about. **And nothing afterwards says the uninstall
    happened**: the package reads the right version and launches. `install -r` preserves
    `firstInstallTime`, so `firstInstallTime == lastUpdateTime` is the ONLY witness - `a1apk.mjs`
    reads both clocks after every install and shouts, with `POST_NOTIFICATIONS`, which a fresh
    install leaves DENIED while every push row assumes it granted. Its refusal names the side too:
    `INSTALL_FAILED_UPDATE_INCOMPATIBLE` is symmetric, and it said "the APK is a RELEASE build" in
    both directions until 2026-09-24, when the phone was the release one
    ([device-verification](../../docs/wiki/device-verification.md#before-you-start)).
  - **`--target aarch64` is not needed and its absence is not a warning to fix.** A full build prints
    "There are no .so files available to package in the APK for armeabi-v7a, x86, x86_64" and
    packages arm64 alone, which is what the Pixel 6a runs. Measured 2026-08-24 on v0.14.4.
- **AND A SOURCE EDIT CANNOT REACH W1 OR W2 EITHER - `SITE` IS THE BUILT ESTATE, NOT THE DEV
  SERVER.** `http://localhost:8081` is nginx serving `_app/immutable/...`, so the browsers run
  whatever `make local-frontend` last produced; a `bun run dev` on 1420 is a different application
  that nothing in this rig looks at. **A product fix is invisible to every row until
  `make local-frontend` has run** - it rebuilds BOTH images, because nginx holds its own copy of the
  assets and rebuilding `frontend-ssr` alone serves the new shell with the old JS. The stamp that
  settles it is `builtAt` on the verdict, read from `/_app/version.json`: if it predates the edit,
  the row measured the code without it. Cost 2026-09-05: a fix to the display-name resolver was
  measured three times against a build made before it, and the console line that disproved it named
  `localhost:8081/_app/immutable` in the stack of the error it was supposed to have classified.
- **A DEPLOY CANNOT REACH AN APK.** `frontendDist` is `../build`, so the phone keeps whatever was
  installed on it and drifts from the fleet the moment anything ships. That is why a verdict carries
  `a1Build` beside `build`: a phase that arms the phone stamps EVERY row by construction, because the
  preflight reads the phone once and hands it down through `CANARI_A1_BUILD`, and a phase with no
  phone carries no stamp. **A row whose question is not skew needs the APK rebuilt and installed
  first**; a row that WANTS an old client against a new server arms itself by not rebuilding.
- **When the preflight blames the phone, restart the SERVER before touching the device**: `adb
  kill-server && adb start-server` clears the state that produces most of them. It also kills any
  background `logcat`, so a run collecting logs has to start them again afterwards.
- **`phone.notifications()` INFLATES every count it returns**, unfixed. Any row asserting on a
  notification COUNT is asserting on that inflation; read the shade itself, or assert on presence.
- **A phone `offline` in adb is a HUMAN action, and no `adb reconnect` clears it.** The screen has to
  be unlocked and the authorisation prompt accepted on the device itself.
- A fresh install is a NEW PROCESS, so the old devtools forward is dead and `pin.mjs --device A1`
  alone reports `ECONNREFUSED`. `bun archive/run.mjs --preflight A1` forwards, foregrounds, sends the app to
  `/chat` (the PIN gate does not mount on `/posts`) and unlocks - use it rather than the pieces.
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

### `callpeer.mjs` - a desktop Chrome as the other end of a phone call

```sh
bun callpeer.mjs --browser w3 --launch --url https://dev.canari-emse.fr/chat --accept --seconds 60
bun callpeer.mjs --browser w2 --launch --wav <file.wav> --dial --hangup   # the conversation open on screen
```

The known-good engine (the call-audio rig measured desktop Chrome clean) on one end, a phone on the
other: the phone that sounds wrong FROM it, or makes it conceal, is the faulty one
([calls](../../docs/wiki/frontend/modules/calls.md#the-mi-9t-logged-no-worker-line-at-all-131-alpha2---the-worker-is-now-asked)).

- `--launch` starts the profile with a FAKE microphone (Chrome's beep, or `--wav`). The flags are
  read at start, so a profile already up is refused: `bun launch.mjs close w3` first.
- Without `--launch` it attaches to the running profile, microphone as is.
- It installs a peer-connection tracker before the app loads, then reloads.
- `--dial` presses the header's audio-call button, `--accept` presses Accept when the phone rings.
  Both labels are read from `frontend/messages/fr.json`.
- It samples the RECEIVER every second and prints packets, loss, concealed %, jitter, level and
  codec every 5 s.
- It writes the samples and every `[Call]` console line (the E2E worker report included) to
  `--out`, default the OS temp dir. `--hangup` ends the call and waits for the end-of-call report.
- The profile must be signed in on the estate the phone uses (`--url`). Accounts stay in
  `test-accounts.json`, out of tree.

### `deployed-wasm-check.mjs` - ask a DEPLOYED estate whether its wasm can panic

```sh
bun deployed-wasm-check.mjs                 # the estate SITE names   0 clean, 1 refused, 2 could not look
bun deployed-wasm-check.mjs https://...     # one particular deployment
```

The estate comes from `SITE`, never from a literal: a rule anchored on a spelt origin does not FAIL
when the estate moves, it ANSWERS - about a host nobody is testing any more. `origin-selftest.mjs`
is the gate that says so, and it caught this file the day it was written.

Walks the JS chunk graph from the landing page, finds the `mls_wasm_bg.<hash>.wasm` the app would
load, downloads it, and refuses if it carries `std`'s unsupported-platform panic text.

**Why it exists.** On 2026-09-06 `v0.16.4` deployed green, both estates answered `HTTP 200`, and
every browser login was refused with *"PIN incorrect"* - `std::time::SystemTime::now()` had reached a
crate that compiles to wasm32, where it is not implemented and PANICS. Nothing between the merge and
the outage could see it: it compiles, the deploy is green, the site answers. Run against production
during the incident it named `mls_wasm_bg.YXThuGSF.wasm` - the exact file in the user's stack trace -
with no credentials, in seconds.

**It is not a login**, and must not be sold as one: it cannot see a defect that needs a session. It
is the part that needs no account and would have caught THIS one. `EXIT 2` means the walk could not
find the asset, which is **not** a pass - "I could not look" and "it is clean" are different answers
and the script keeps them apart.

**IT IS A GATE SINCE 2026-10-06.** `serve-dev.yml` runs it against the dev estate BEFORE it moves the
`dev-deployed` marker, and the stable's fourth preflight gate reads that marker - so a refused wasm
cannot reach production. With an explicit origin it needs no `names.mjs` (git-ignored, so absent in
CI); the landing page is fetched under its own query so the edge's 60 s shell cache cannot answer for
the previous build. `archive/deployed-wasm-selftest.mjs` drives the real script against a loopback
estate for the three exit codes.

**Its sibling guards the build**: `frontend/scripts/check-wasm-no-unsupported.mjs`, wired into
`bun run wasm:build`. Both are needed - a build can be fixed while an estate still serves the old
image, which is exactly the state production was in for the twenty minutes after the fix was merged.

### `invariant.mjs` - the five things every MLS row asserts besides its own question (R8)

```sh
bun invariant.mjs --group <uuid> --device W1,W2 --to "<conversation>" --from-epoch 7 --since <ISO> --reload
```

Section 4.0 of the 1.4.1 campaign plan (`docs/wiki/cross-client-campaign-1-4-1.md`): one tree
(every member at the server's epoch, no `[FORK]`/`[INTEGRITY]` line), no stage left and the commit
log holding exactly one row per epoch the row moved, two messages sent AFTER the event reaching every
member once, in order, from the right author, no forbidden line (`ACCEPTED AND NOT HELD`, `ERASES`,
`UNREADABLE`, `[ADMISSION]` at ERROR, `is ABSENT from the state this foreground keeps`, a 5xx) and no
logout, and the roster agreeing with the tree. `--reload` judges it all again after a reload of every
web client, which is what proves the state was SAVED. Written once: a runner calls `checkInvariant()`
with its own `watch()` results, so the console of the whole row is judged, not only the probe's.

The verdict is `invariantverdict.mjs`, pure, pinned by `archive/invariant-selftest.mjs` in `make
test-harness`. **It reports APPROXIMATIONS beside failures**, because three readings have no window
hook on the current build: the epoch FINGERPRINT (epoch equality plus no fork line stand in), a
client's `pending_submission` (the commit log stands in), and the tree's LEAVES (the server's active
device seats stand in). A collector that can read one passes it and the approximation goes away. It
WRITES two messages into `--to`, so on dev it is pointed at a campaign-owned conversation only.
`--to` may also be one name per device (a DM shows each side the other person).

### The 1.4.1 row runners - `mlsrow.mjs`, `rowkit.mjs`, one table per group

```sh
bun archive/floor.mjs --row 1    # FLOOR-1, W1 W2
bun archive/floor.mjs --row 2    # FLOOR-2, W1 W2 W4 W5 - a fresh FLOOR2-<mark> group, ONE bulk Add
bun archive/floor.mjs --row 3    # FLOOR-3, + A1 I1, on FLOOR-2's last group (or --group <uuid>)
bun archive/run.mjs FLOOR --repeat 5   # FLOOR-1 and FLOOR-2, five draws, through the preflight
```

A runner per row GROUP of section 4.2 (`archive/floor.mjs` first), each one table and one action per
row. Everything else is shared: `mlsrow.mjs` opens and watches the seats a row names, mints the row's
own group (`<GROUP><n>-<mark>`, recorded in the ledger with its id and swept by `debris.mjs`),
asserts R5 ownership of every conversation the row writes in, and reads the server's view;
`rowkit.mjs` (pure) composes the verdict - `INVALID` when the premise could not be built, `VACUOUS`
when an armed fault never fired, `FAIL` on any own assertion or invariant, else `PASS` - and
`recordObserved` then gates it on every seat's window, the deploy exclusion (R4) and the server window
judged by the row id (R6). The invariant (R8) runs after every row, with its reload. A row's own
judgements live in `<group>rows.mjs` (`floorrows.mjs`, `ccrows.mjs`, `settlerows.mjs`, `gaprows.mjs`, `offlinerows.mjs`, `killrows.mjs`, `admitrows.mjs`, `devicerows.mjs`, `salonrows.mjs`, `bigrows.mjs`), pinned by
`archive/<group>-selftest.mjs`.

```sh
bun archive/cc.mjs --row 1|2|3|4         # CC-1..4: two commits at one epoch, released together
bun archive/run.mjs CC --repeat 5        # the set of five the plan's verdict is
```

**A race** is `mlsrow.mjs` `raceCommits`: each racing seat's `POST /api/mls/commit` is held before
the server (`fault.mjs` `hold once`, so a rebuilt retry passes), the gestures start together, and
once every seat holds its request they are released in one `Promise.all`. A seat whose request
never arrived makes the row `VACUOUS`. The evidence is the gate's own `[COMMIT]` lines since the
release (`ACCEPT`, `REJECT epoch_mismatch`, `REJECT concurrent_commit`) - a refusal is answered `201
{accepted: false}`, so no client network log can tell it from an acceptance. **CC-4 arms the leaf
refresh on the device** (`armLeafRefresh`: the refresh ledger is the device's own `localStorage`,
backdated eight days on a leaf its own commit produced), inside the race so no earlier frame spends
it. **CC-5 is BLOCKED-ON-ACCOUNT** - it needs a fifth campaign account (`ccrows.mjs` `CC5_PREMISE`).
The contract is the OUTCOME: one winner, the loser refused with either race refusal and rebuilt;
which code it met is recorded in the detail (`refusalCodes`), never judged.

```sh
bun archive/settle.mjs --row DUP-1|DUP-2|DUP-4|DUP-5|DUP-6|OFF-1|OFF-2|TOK-1|TOK-2
bun archive/settle.mjs --row DUP-3       # records SKIPPED with the plan's reason (Q2)
bun archive/settle.mjs --row TOK-3       # 61 min with the socket open - run alone, unattended
bun archive/run.mjs SETTLE               # every settlement row but TOK-3
```

**A settlement row** arms a fault on W1's commit POST (`fault.mjs`), then Adds the row's subject:
the answer lost (`lose-answer`), refused (`status 409` with the `SEAT_CLAIM_OVERTAKEN` body the
client types by - `status` takes a `body` since this runner), answered `503`, held past the write
deadline (`hold-answer`), or failed under a cut (`hold` / `hold-answer` then `fail()` once
`net.mjs` `cutHard` is in place). Every step after waits on a FACT: the fault firing, the client's
own `[COMMIT] <group>... resubmission of the commit from epoch N: <verdict>` line, the gateway's
reconnection. The evidence is the gate's log IN ORDER (`settlerows.mjs` `commitSequence`):
one `ACCEPT`, the resubmissions `DUPLICATE`, nothing refused - a kept commit is settled, never
rebuilt. **What a fault provokes is forgiven exactly, one line each**: `rowkit.mjs`
`forgivingProvoked` takes the fault's records off W1's window (a transport failure included, which
`ignoringExpectedRefusal` cannot match), and `checkInvariant({provoked})` forgives each provoked
5xx once in invariant 4 and names it as an approximation. DUP-7 needs a new device and is played by
the device runner.

```sh
bun archive/gap.mjs --row GAP-1|GAP-2   # frames ahead of their commits; past-epoch frames again
bun archive/gap.mjs --row GAP-3         # 2100 sends, then a pull that starts past 2050 - run alone
bun archive/gap.mjs --row GAP-4         # records SKIPPED (the shared-payload writer stays off)
```

**A GAP row acts on the PENDING PULL**, the one place a client-side rig can touch the order of a
member's stream: no CDP tool reaches a socket frame, but what a seat drains on its return is an
HTTP answer. So the row cuts W2 (`net.mjs` `cutHard`), lets the server queue what it misses, and
rewrites the pull of its return with `fault.mjs` `rewrite` (the body, through the rule's
`transform`) or `rewrite-url` (the url, through `url`): GAP-1 takes the group's commit rows out
and holds rung 1's `GET /api/mls/commits/` while W1 sends live; GAP-2 captures a frame from one
pull and puts it in front of a later one, three epochs on; GAP-3 starts the first page `after` the
2050th queued frame. Rows left out are not ACKed, so nothing is deleted on the server. The
transforms are `gaprows.mjs`, pinned by `archive/gap-selftest.mjs`.

```sh
bun archive/offline.mjs --row OFF-3|NET-1|NET-2|NET-3|RM-8   # browsers; NET-2 is five minutes
bun archive/offline.mjs --row OFF-5                          # A1, class B: the radios go mid-Add
```

**AN OFFLINE ROW TAKES A SEAT'S LINK AWAY FOR A DURATION**, where a settle row loses one answer.
OFF-3 holds W1's Add before the server, cuts W1 and fails the held request, then lets W2 move the
group three epochs (an Add of W4, two refreshes of the leaf that Add dated); on the return the kept
commit must be refused `epoch_mismatch`, cleared and re-issued. OFF-5 is OFF-2 on A1 with the radios
(`svc wifi/data disable`, and the USB reverse on the local estate) as the cut. NET-1 uses `net.mjs`
`degrade` (latency and both throughputs; CDP has no loss rate, and the record says so). NET-2 cuts
W2's socket on every other 5 s tick for five minutes while W1 sends each tick and refreshes its
leaf every 18. NET-3's portal answers every `/api/` call `200 text/html`, armed through
`addMembers`' `beforeSubmit` so the picker's search is not what it breaks. RM-8 leaves under `cut()`
and asks only that the server and W2 agree. Judgements in `offlinerows.mjs`, pinned by
`archive/offline-selftest.mjs`.

```sh
bun archive/kill.mjs --row KILL-1|KILL-2|KILL-3|KILL-5|RM-3   # browsers: a tab closed, a browser killed
bun archive/kill.mjs --row KILL-4                             # A1, class B: force-stopped
```

**A KILL ROW CHOOSES ITS SIDE OF THE SERVER, THEN DRAWS ONLY THE DELAY.** Each run's commit is a leaf
refresh (`armLeafRefresh`, then a send), held by `fault.mjs` either before the server (`hold`) or
after the accept (`hold-answer`); runs alternate the two, and the kill lands a drawn 0-800 ms into
the hold. `archive/reopen.mjs` kills a seat and PROVES it dead (`killSeat`: the tab gone from the
browser's list, the port quiet, the pid gone - a swipe that leaves the app alive throws), then
revives it the user's way, PIN included, and replaces the seat's `cx` and `w` (`reviveSeat`). The
outcome is read on the SERVER - merged once or cleared, the seat caught up, traffic both ways -
because the settlement runs at the connection, before a `watch()` can attach to the new page.
KILL-4 has no `[CHECKPOINT]` line to time on: one un-killed run measures the send-to-request window
and each kill lands at a fraction of it. KILL-5 holds `POST /api/mls/welcome`; RM-3 holds the roster
delete's answer and measures how long W4's seat outlives it. **A RUN OWNS ONLY THE COMMITS PAST
THE EPOCH IT READ** (`runCommits`): its window opens before that read, and an accept naming an epoch
the read already saw is a STRAY (`strayCommits`) - an own commit no run armed, which fails the run it
preceded, as does one after the last run. Each run writes the killed seat's DYING and REVIVED
consoles to `logs/consoles/` (`keepConsoles`), because the row's end keeps only the last page.
Judgements in `killrows.mjs`, pinned by `archive/kill-selftest.mjs`.

```sh
bun archive/admit.mjs --row ADM-1|ADM-2|ADM-3|ADM-4|ADM-8   # browsers
bun archive/admit.mjs --row ADM-5|ADM-6|ADM-7               # A1 on the v1.4.0 APK, installed first
```

**AN ADMISSION ROW FOLLOWS A GROUP LINK AND ANSWERS ITS ASK.** `archive/grouplink.mjs` mints the link
from the panel, follows it as the joiner (the page must say the request was SENT), and reads and
answers the ask on its own row (`[data-join-request]`, matched by person, never position) or sees
it in the banner. ADM-3 holds the Add's commit on one member and the Decline's request on the other
and releases them together. ADM-4 calls every member route from the waiting seat's page (the table
is `admitrows.mjs` `memberRoutes`); each must answer `409 awaiting_admission`. ADM-5..7 REFUSE a phone
not on the `v1.4.0` build (its own `/_app/version.json` against the tag's commit), and ask the server
from the phone with `chat.mjs` `apiAt` - a phone's page is `tauri.localhost`, not the estate. **A1
signs in as the owner**, so ADM-5 and ADM-7 run in a group of W2's and W4's. The link's token is never
recorded, only its length. Judgements in `admitrows.mjs`, pinned by `archive/admit-selftest.mjs`.

```sh
bun archive/devrows.mjs --row DEV-1|DEV-2|DEV-3|DEV-4|DEV-6|DUP-7   # browsers; mints on W3 (and W6)
bun archive/devrows.mjs --row DEV-7 --variant cold|opened|stale     # A1 swiped away
```

**A DEVICE ROW MINTS IN ITS OWN PROCESS.** `newdevice.mjs` binds its device from `--device` at import,
so each mint is `archive/mintdevice.mjs`, which prints one `MINTED {json}` line and records nothing;
DEV-4 starts two at once. The minted seat is opened and watched BEFORE the mint, so its whole join is
in the row's window. A revoke is `purge-devices.mjs` from W1 (its allowlist is the campaign ledger).
DEV-3 installs the socket patch before the mint (`net.mjs` `armCutOnNextLoad`), so the mint's own load
carries it. DUP-7 and DEV-7 pick ONE group's request on a shared route with `fault.mjs` `bodyIncludes`:
a new device makes its owner commit in every group at once. **W6 is the owner's second scratch
profile**: it must be declared in `names.mjs` (owner account) and signed in once by a human. DEV-5 is
played with CORRUPT-8. Judgements in `devicerows.mjs`, pinned by `archive/devrows-selftest.mjs`.

```sh
bun archive/salon.mjs --row RM-4|RM-4b|RM-5|RM-6
```

**RM-4 RACES TWO GRANTS, RM-4b TWO REVOKES, because the panel sends them down different routes.**
A grant (and the visibility toggle, and the write policy) is the access PATCH, whose locked
re-read refuses `409 CHANNEL_ACCESS_CHANGED`; the trash beside a member is
`DELETE /api/channels/:id/members/:userId`, which strips one user under the lock, so two revokes of
two members both stand. RM-4 held a revoke's PATCH until 2026-10-25, a request the panel never sent.

**A SALON ROW MINTS ITS OWN COMMUNITY.** W1 creates it, the other seats join by its link, and it is
deleted once the verdict is on disk, so the roles, the private salon and the kicked member are the
campaign's alone. Every gesture is the panel's own (`comm.mjs`); a race holds both requests and
releases them together, and each answer is read from the page's own Network events
(`salonrows.mjs` `statusesIn`). RM-6's moderator is left holding `channel.manage` alone through
W1's permission grid. **A salon is not a sidebar conversation**, so section 4.0's message probe is
replaced by the salon's own invariant: every user the server entitles holds an active seat in the
salon's group, and nobody else does (`salonEntitlement`). Judgements in `salonrows.mjs`, pinned by
`archive/salon-selftest.mjs`.

```sh
bun archive/big.mjs --row BIG-1|BIG-2|BIG-3   # every seat: W1-W8, A1, I1 (class B, run by hand)
```

**THE LARGE ROWS USE EVERY SEAT.** The owner is on W1, W3, W6, A1 and I1, the peer on W2 and **W7**,
the third account on W4 and **W8**, the fourth on W5. W7 and W8 must be declared in `names.mjs` and
signed in once by a human. BIG-1 and BIG-2 mint a group and add the three other accounts in ONE bulk
Add. BIG-1 reads each phone's `[MLS] Encrypted state checkpoint persisted. (N ms)` line, recorded
with the phone's build. BIG-2's two commits are W1 leaf refreshes armed inside its own burst. BIG-3
mints a community under `joined` history, removes the third account, then admits the fourth, and
reads each sender's Graine sessions per phase from `channel_messages`. Its invariant is the
community's membership (`communityEntitlement`). There is no `checks.mjs` phase: the rows need both
phones. Judgements in `bigrows.mjs`, pinned by `archive/big-selftest.mjs`.

```sh
bun archive/handrow.mjs --row LIFE-5|CALL-12|CALL-13 --verdict PASS|FAIL|INCONCLUSIVE|SKIPPED --what "<observed>" --since <ISO>
```

**A ROW ONLY A PERSON CAN PLAY IS RECORDED, NEVER WATCHED.** The `O` rows of the plan's section 4.3
need a gesture no tool performs, so the person's observation goes in `handObserved` and the client
side is `unobservable`; no `clean` key is written. The rig reads the one observer it still has, the
server window from `--since` (the start the lead gives), and a window that is dirty or unreadable
demotes a PASS to `PASS-DIRTY`. `SKIPPED` takes no `--since` and records the reason. TOK-3 is not a
hand row: `settle.mjs` runs it unattended. Judgements in `handrows.mjs`, pinned by
`archive/handrow-selftest.mjs`.

## Rules that make a result trustworthy

**Thirty-one** harness faults produced a false verdict before these were learnt. They are distilled,
with their examples, in [testing-methodology](../../docs/wiki/testing-methodology.md) - read that
page before writing a check or believing one. The ones that decide whether a run is worth reading at
all:

- **ONE DRIVER PER BENCH PHONE AT A TIME**, assigned by the lead (BENCH-SHARED-2, 2026-10-21): a second
  session's swipes and reloads spoiled a reading. [testing-methodology](../../docs/wiki/testing-methodology.md#one-driver-per-bench-phone-at-a-time-bench-shared-2-2026-10-21).
- **A PUSH ROW MEASURES CANARI ONLY IF THE PHONE'S LINK TO GOOGLE IS ALIVE, AND THAT LINK FAILS
  `ESTABLISHED`.** Four verdicts on 2026-09-07 named the app over a transport that had silently
  stopped carrying anything while every readable fact - standby bucket, Doze whitelist, `ping`, the
  token in the database, the server's own `FCM sent` - said it was fine. So every runner that calls
  `phone.awaitNotification` renews the link first through `requireFreshFcmLink` and REFUSES when it
  cannot get a new one; `archive/transport-selftest.mjs` refuses a runner that forgets. The story is
  in `fcmlink.mjs` and in [testing-methodology](../../docs/wiki/testing-methodology.md).
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

The browser report attributes every console line to the ORIGIN that emitted it (`consoleorigin.mjs`: execution-context origin, then the top stack frame, then a non-network log entry's url; a network entry's url names the resource and is never an emitter). Lines from a foreign origin (the identity provider's console during `login.mjs`) are removed from `unexplained` and REPORTED as `foreignOrigins`, a count per origin, mirroring the phone report's `foreign` bucket; an unattributable line is never forgiven (#1277).

## Standing constraints

- **Runs against the LOCAL estate (since 2026-09-03) or DEV (since 2026-10-24), never production** - `SITE` in `names.mjs`, one constant read through `site.mjs`, and
  every file derives its host from it rather than spelling one (89 literals were swept out on
  2026-09-04 for exactly that reason). The estate is `infrastructure/local/docker-compose.yml`, built
  and served by nginx on `${CANARI_LOCAL_API_PORT:-8081}`; its database holds no production data (production data is never copied to a workstation).
  **Two things do NOT become local with it.** The identity provider is still
  `auth.canari-emse.fr` by decision 8 of the workflow migration, so the accounts and their passwords
  are production's - and the local Authentik client is a SEPARATE provider (`Canari Local`), which is
  where a local redirect URI has to be declared or the login dies on "Redirect URI Error". And the
  object store starts EMPTY, so a row whose question is about media uploads what it then reads.
- **Every test message goes in the two-test-account DM and nowhere else.** Anything needing a channel
  uses the `Canari Test Venue` community, never MiTV - a private channel there is readable by every
  association admin. **A prod dump does not hand that venue over**: its rows belong to whichever
  accounts owned them on production, so `venue.mjs` will refuse ("owner UNRESOLVED") until the
  campaign's own accounts create it.
- **No PIN, login, display name, device id, group id or device serial goes in a committed file.** The
  peer's real display name reached the public archive once already, through a check that spelt it
  inline rather than importing it.
- **Clean up after the campaign.** It creates groups, devices and backlogs on the production database
  that later runs then measure and cannot tell from real traffic - see the cleanup section of the
  dashboard. Restore Firefox as the device's default browser afterwards
  (`cmd role add-role-holder android.app.role.BROWSER org.mozilla.firefox`); it was switched to
  Chrome only because Firefox exposes no CDP.
