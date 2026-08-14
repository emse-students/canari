# Testing methodology: how a result earns the right to be believed

This page is about **measurement**, not about any one feature. It is the distillation of the
**thirty-one harness faults** that produced a false verdict during the
[cross-client campaign](cross-client-testing.md) - each one a check that reported PASS or FAIL for a
reason that had nothing to do with the application.

It is worth its own page because the faults are not campaign trivia. Every one of them is a way of
being wrong that survives the harness that produced it, and several of them cost a shipped bug: a
green check whose noise was ignored, an invented app defect that was a selector, a verdict computed
over a filtered copy of its own evidence.

> **Read this before writing a check**, and before believing one. The
> [rig itself](../../tools/cross-client-harness/README.md) is a separate document: that one is the
> instrument, this one is the epistemics.

---

## The eleven rules

Ordered by how expensive it is to break them.

### 1. A verdict must never be computed over a projection of its own evidence

`heal-web.mjs` filtered the console through a **display** regex, then ran its matchers over the
**filtered** text. A line the matcher accepts but the filter drops is invisible, so the check
reported `escalated=false` on a run whose repair had demonstrably run.

A capture filter is presentation. The verdict reads **everything** the run produced, and only the
report is abridged. If the two must share a regex, the verdict's is the superset - never the
other way round.

### 2. Every action asserts its own post-condition

An action that cannot prove it took effect still yields a verdict, and **that verdict is fiction**.
The campaign produced this one five separate times:

- `am kill` on a **foreground** process is a silent no-op - it returns success and the app lives.
  Go HOME first, then assert the death (`pidof`).
- A "relaunch" that opened a new tab instead, so the check measured a fresh page that had never been
  through the transition it was testing.
- A `pidof` that exits 1 **exactly when** the thing it measures happens, so the harness read the
  failure as a shell error.
- A navigation that failed, was swallowed, and left the check counting rows on the previous screen.
- A zoom button never clicked, because the guessed `aria-label` did not exist - the check still
  asserted "something changed" and passed.

### 3. "Did the state change" is almost never the assertion. "Did it change into the RIGHT state" is

The corollary of the last item above. A pinch check asserted that the scroll position moved; it
moved, and the page had zoomed about the wrong point, which is the entire defect the check existed
to catch.

**Validate every check as a NEGATIVE CONTROL against the unfixed build before its green means
anything**, and set its tolerance from those two measurements rather than from taste. A check that
has never been seen to fail is not a check.

### 4. Assume a green check is wrong until its evidence says otherwise - and a FAIL too

A FAIL is not evidence about the application until the fixture and the selector have been ruled out.
Two examples on opposite sides:

- A media check passed against a fixture whose PNG CRCs were invalid - it was never rendering
  anything.
- `check-feed-retry` reported FAIL against a feed that was visibly rendering posts, because it
  counted `article` / `data-post-id`, neither of which the feed emits (`PostCard`'s root carries
  `group/card`).

**A locator failure does not bias the verdict in a predictable direction**, which is why it cannot
be discounted as "conservative".

### 5. A locator is a guess unless it is disambiguated - and a DEVICE is a locator

Name an element from the **component source**, never from what the markup ought to be. Scope any
selector shared by two surfaces: `.chat-composer-editor` also exists on the social feed, so every
use is scoped to `.chat-composer-footer .chat-composer-editor`.

The device half is the same rule one level up: with two adb transports attached (USB and TCP), every
`adb` call needs `-s <serial>`, and the serial is **resolved** from `adb devices` rather than
hard-coded. `/json/list` is not creation order, so a CDP target must be identified by what it
contains, not by its index.

An `aria-label` must never outrank visible text, and a document-wide text match hits the first
hidden row.

**A reader scoped to a surface answers `0` when that surface is absent, and `0` is exactly what a
lost message looks like.** `countMessage` reads the message pane; the phone is single-pane, so it
shows the conversation LIST after a reload and after a fresh launch, and there is no pane to read.
Two probes came back `0` on 2026-08-13 and were one step from being written up as lost messages -
both were on screen throughout, one of them visible in the list's own preview line. Any reader of a
conversation must therefore ESTABLISH the conversation first (`ensureConversation`, which is a no-op
when it is already open) rather than assume the client stayed where the last step left it. The same
single-pane fact breaks the writer: `openConversation` hunts a sidebar that no longer exists once a
conversation is open, so it fails on the phone precisely when the target is already correct.

### 6. A matcher tests one SPELLING; the absence of an entire VOCABULARY is evidence about the app

When a mechanism leaves no trace, a **stale matcher is the right first suspicion** and it is cheap
to rule out: grep the log for every word the mechanism could have used, not for the one string the
check happens to look for. Only once the whole vocabulary is absent does the silence say something
about the application.

Its mirror image: two lines that **no longer exist in the codebase** appearing in a run means the
client is on an old build. Check the deploy before believing anything else that run says.

### 7. A check that puts the app through a transition must restore every precondition that transition destroys

A kill, a reboot, a radio cycle and an `install -r` **all re-lock the PIN**. A precondition
discovered by one check belongs to every check sharing the transition, so it goes in the shared
setup, not in the check that found it.

**And the rule applies to the SETUP ITSELF, where it is easiest to miss.** A repair is a transition,
so one repair can produce exactly the state another repair exists to fix - which makes a fixed
sequence of one-shot repairs wrong however well each one is written. `run.mjs`'s preflight repaired
`unknown` (a client on a route where the PIN gate never mounts) and then `LOCKED`, once each in that
order; unlocking leaves the client wherever it already was, so a freshly launched phone went
`LOCKED -> unlock -> unknown on /posts` and the preflight refused a client that was one step from
ready and healthy throughout. The repairs now **iterate** to a fixed point, bounded on PASSES.

The bound is not the interesting half - the report is. An exhausted bound prints the TRAIL, because
`LOCKED -> unknown -> LOCKED` (a client re-locking on every navigation) and `unknown -> unknown` (one
that never moves) end in states whose last value cannot tell them apart, and they want opposite
fixes.

**AND THE SETUP IS A PRECONDITION OF EVERY SCRIPT, NOT AN OPENING CEREMONY.** The preflight ran once,
before the first job, and the eleven scripts after it started from whatever the previous one left
behind - so the result of a phase depended on the ORDER and on the leftovers, and a green run proved
nothing about the next one. That is the exact opposite of what a phase is for: a phase exists to be
**re-run after a change to show the system is still healthy**, and a phase that cannot be replayed
from a defined state cannot show anything.

It cost a real diagnosis on 2026-08-14. MSG-5 left the "Ajouter un canal" dialog open; MSG-1b,
MSG-6/7, MSG-9 and MSG-10 then all died inside `ensureChat`, each pointing at an application that was
working perfectly - four checks accusing the wrong component, which is worse than four checks not
running. Note what the existing signals said about that client: reachable, unlocked, on `/chat`, full
sidebar. **An overlay is invisible to every readiness probe and swallows the first click**, so it is
now part of what "ready" means, repaired loudly like the others. And a job whose clients cannot be
brought to a known state is reported BLOCKED rather than run: it never executed, so it has no verdict
at all, and saying so is the difference between "the app misbehaved" and "the question was not
askable".

### 8. When a check's BREAK is not invertible, the teardown restores a PROPERTY, never a snapshot

Rewinding a sender cannot be undone by restoring any state: while the fork was live, the peer
consumed generations off it, so **no snapshot is both legitimate and ahead of the peer**. Restoring
one re-creates the very break.

Ask what the next run actually needs - "can this device still deliver?" - and assert that invariant
on every exit path (`ensureDeliverable`). A teardown that only runs on the happy path is not a
teardown.

### 9. DATE THE BUILD BEFORE BELIEVING ANYTHING IT SAYS - and the build's own log strings are the date

A1 was measured for hours on 2026-08-11 against a **debug** APK several commits stale, and nothing in
the check said so. The fingerprint was in the evidence the whole time: the phone printed
`[QUEUE] STUCK: messageCallback has not settled after 60s`, a string `93244a7b` had **deleted** that
same day when it replaced the single-step watchdog with `guarded`. One `git log -S` on a line the
device logged dated the build in seconds - which is the general method, because a log string is
version-stamped evidence a running process hands you for free, while `versionName` is a constant
somebody edits at release time and had read `0.13.1` on both.

Two consequences, and the second is the expensive one:

- **A debug build is not the app.** WP-ANR-1's own note measures debug at ~10x release on the same
  fixture, so a TIMING verdict from a debug APK is not a weak result, it is an answer to a different
  question. Behavioural verdicts survive the distinction; performance verdicts do not.
- **Check the SIGNATURE before planning an install, not after.** `dumpsys package | grep pkgFlags`
  says `DEBUGGABLE` outright, and a debug-keystore install and a release-signed APK cannot replace
  one another - `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, and the only way across is an uninstall that
  wipes `mls.bin`. Discovering that at the install step means the whole preceding setup was arranged
  for a step that could never run.

Same family as rule 1: `versionName` is a projection, the running code is the evidence.

### 10. THE ABSENCE OF A FAILURE IS NOT EVIDENCE OF SUCCESS - prove the path was EXERCISED

A check for "the push-authenticated fetch no longer 403s" counted zero rejections and wanted to call
it PASS. But the process had cached both avatars hours earlier, so it never made a request: the
verdict was measuring a path that did not run (WP-DIRECTBOOT-1). Every check whose assertion is the
absence of something needs a second, POSITIVE assertion that the mechanism fired at all - and it must
be reported next to the verdict, so a VOID run cannot be mistaken for a green one.

The trap that hides it here is **two success logs one word apart**:

| line | what it means |
| --- | --- |
| `fetchAvatar: from cache for X` | cache hit - **no network, no Keystore, nothing under test ran** |
| `fetchAvatar: avatar cached for X` | an HTTP fetch succeeded and was written - the authenticated path DID run |

A matcher written as `/(avatar cached\|from cache)/` therefore reports success for the one outcome
that proves nothing. Read the source at the log site before trusting a string that merely sounds
right; and to force the path, remove what makes it skippable - here
`adb shell run-as fr.emse.canari rm files/avatar_*.jpg`, which works because the build is
DEBUGGABLE, one of the few things a debug build is BETTER for (rule 9).

**Where the defect can be re-created, the check should re-create it.** WP-RELOAD-DL-1 asserts that a
reload does NOT navigate - and a build with deep links entirely broken passes that too. Deleting the
one key the fix relies on (`sessionStorage['canari:deeplink:handled']`) and reloading again brought
the replay straight back, which is what turns "nothing happened" into "the guard held". A PASS whose
failure you cannot produce on demand is the weakest kind there is.

#### The sharpest instance: a run that printed PASS while the branch never ran

WP-ECHO-1's device check sends its own message "during a drain" and asserts it survives a reload.
Version 2 printed `PASS - every message sent during a drain survived the reload`, on seven real sends
and a real reload. The capture said otherwise: the seven sends were at 13:20:23-13:20:39 and the
run's **first drain opened at 13:20:42**. Nothing had been sent during a drain at all, so the fix
under test was never reached and the correct verdict was VOID.

The cause was structural, not carelessness: the check spaced its sends with `sleep`, and the window
it needed to hit is the app's own bulk-ingest phase, which measured **15 ms to 1.4 s** depending on
the decrypt. A delay cannot aim at a duration the app chooses. Two changes fixed it, and both
generalise:

- **Trigger on the SYSTEM's own signal, not on a delay.** The check now arms the composer, waits for
  the phone's log to show a new window opening, and fires into it - so the only work between the
  event and the action is one CDP round trip. (`armComposer`/`fireComposer` exist purely to make
  that gap small; the ordinary `send` is now their composition, so nothing else changed.)
- **Report the exercise count NEXT TO the verdict, from an exact discriminator.**
  `[ADD_MSG] ✓ Message added` is logged by `addMessageToChat` alone, and inside a window an inbound
  message returns early into the buffer without logging it while the later flush goes through
  `batchAddMessages`, which never logs it. So that line inside a window can only be an own message on
  the live path. The run reports `inside a window: N`, and **N = 0 is a VOID**, whatever the reload
  then shows. The passing run reported 5.

The general form: when a check must act inside a window it does not control, find the log line that
opens the window, and find a line that can only be emitted by the branch under test. Without the
first the check cannot aim; without the second it cannot tell you it hit.

#### The corollary for a PERFORMANCE verdict: fast and skipped look identical on a clock

WP-ANR-1's check measures a duration - `onReceive` to `drainPendingOutbox: done` - against the 60 s
the OS gives a `goAsync()` receiver. It came back at **2 331 ms** where the defect measured 58.6 s,
and that number on its own is worth nothing: a drain that saw the radios were off and gave up before
encrypting anything would also finish in two seconds, and it is a perfectly plausible implementation.
A duration is a *lower* bound on work done, never a statement that the work happened.

So the exercise assertion for a performance check is a COUNT of the expensive operation, taken from
a line only that operation can emit. Here: 100 `PrivateMessage::try_from_authenticated_content` and
100 **distinct** ratchet generations in the OpenMLS trace, against **one** `MlsDeviceKeyStore.retrieve`
for the whole process. That triple is the `O(|mls.bin| + N)` shape observed rather than assumed -
and the keystore-load count is the one that would have caught a regression back to the per-message
entry point, because that regression is fast per call and only the *number* of loads betrays it.

### 11. FORGIVING AN EVENT MEANS TAKING IT OUT OF THE GATE, NEVER OUT OF THE RECORD

A classifier exists to decide what breaks `clean`. It is not entitled to decide what is *kept*, and
the two get conflated the moment a bucket is emptied rather than moved.

`ignoringOfflineCut` did exactly that. A check that cuts the link on purpose must not be marked dirty
by its own cut, so the function set `wsEvents: []` - correct as a gating decision, and it destroyed
the only DATED record of the instant the socket died. When WP-RECONNECT-2 turned on precisely that
instant, the answer had been thrown away by the instrument, for being expected. **Expected is not the
same as uninformative**, and the events a check deliberately provokes are usually the best-timed
things in its whole capture.

The same mistake has a quieter form: **a line with no clock cannot be placed, and bucket order is not
a clock.** `[WS] Disconnected` is a `console.warn`, so it carried no timestamp where every
`appendLog` line around it did; it was placed at one end of a 98-second hole by the order it appeared
in a bucket, and that inference reversed the diagnosis when it was questioned. CDP has carried the
real clocks all along - epoch milliseconds on console events, monotonic seconds on network events,
convertible through the one event that carries both - and none of it was being read.

So: two fields, not one. `wsEventsDuringCut` beside a `wsEvents` that the gate may empty, and a
`timeline` that dates and interleaves everything regardless of which bucket a line ended in. **The
question a capture will be asked is rarely the question it was written for**, which is the whole
argument for keeping the raw sequence next to the verdict.

---

## Observation is part of the check, not a debugging step

Decided 2026-08-06, after two shipped bugs came out of the logs of **passing** checks.

A check that only asserts its own outcome answers "did the message arrive", never "did it arrive for
the right reasons" - and a pass sitting on a swallowed exception, an unread 4xx, a request that
should not have been made, or a reconnect mid-measurement is worth nothing.

`watch.mjs` therefore attaches to every client for the duration of every check and sorts what it saw
into buckets, reported next to the verdict:

| Bucket | Meaning |
| --- | --- |
| `errors` / `exceptions` / `badHttp` / `wsEvents` | anything here makes the run **not clean**, whatever the assertion said |
| `notable` | not an error, but it happened: `SecretReuse`, `out of bounds`, `Duplicate`, `silent ACK`, `epoch`, `GAP`, `out-of-sync`, `welcome_request`, `forget`, `revoke` |
| `stateChanges` | the client changed under the check's feet - gateway reconnect, token refresh, session change. Explains a latency or a retry that would otherwise look like a result |
| `unexplained` | everything not on the known-benign list, **verbatim** |

A verdict is `PASS` only when the assertions hold **and** the run is clean; otherwise
`PASS-WITH-NOISE`, which is a result that still needs reading.

**A line that turns out to be routine is ADDED to the benign list, never ignored in place.** That is
the whole mechanism: the `unexplained` bucket only keeps its value if it shrinks by decision.

**AND A RECORD THAT SAYS `clean: false` MUST SAY WHY, IN THE SAME ROW.** MSG-10 reported a dirty
sender on 2026-08-14 with `senderSevere: []` and `senderErrors: []` printed beside it, because the
two buckets that check happened to keep were not the two that had broken its verdict. The only way to
learn what it saw was to run it again - and it came back clean, so the cause is now unattributable
and stays that way. **A result you cannot read is a result you cannot believe, and a re-run is not a
recovery: it destroys the evidence it was meant to recover.** Each check listing buckets by hand is
how they drift apart from the definition of `clean`, so they are listed once, next to it: `dirtOf()`
returns every clean-breaking bucket that is non-empty, and checks record that.

### The bar is "expected", not "no failure" - and it applies to the server too

Set by the user on 2026-08-13, and it raises everything above: *"je veux que tout soit explique et que
le comportement, y compris dans les logs web, mobile, et serveur, soit completement normaux et
attendus. Limite tu devrais savoir exactement avant de le voir. Nous devons etre intransigeants."*

So the discipline is **predict, then read**: say what the log should contain BEFORE the run, and
afterwards account for every line that is not on that list. Each one is either understood and written
down as benign *with its reason*, or it is a finding. There is no third bucket. "Pre-existing",
"benign", "probably the IPC warming up" are not explanations - they are the places where an
explanation is owed, and each one is a mechanism nobody has looked at yet. The server's logs are in
scope exactly like the two clients': a check that reads only what the UI printed has observed one
third of the system.

Two rate rules follow. **A claim about frequency needs a denominator** - "it fires on every launch"
is a measurement (N cold starts, N observations), never an impression from one occurrence. And **a
measurement taken on a locked client measures nothing**: entering the PIN is part of starting a
client, not a step before the interesting part, because MLS does no work at all until it is unlocked.
The app's side of that contract is a property worth asserting rather than assuming: **it must not
attempt MLS work before a PIN has been entered** (a stored PIN or biometrics count as entered), so
MLS activity observed before the unlock is a defect, not a timing quirk.

---

## Reconciliation: the only way a silent loss can be seen

A silent loss leaves no mark anywhere a **single** client can look. The sender keeps its optimistic
echo, the server answered `201`, and the receiver simply never had the row - so both UIs are
self-consistent and both are wrong about the conversation. The only evidence is a **set difference**
between two clients' view of one thread.

Every campaign message therefore carries a unique `PREFIX-<base36>` marker: DOM rows have no id, but
the text does, and the marker embeds its own send time.

Getting this measurement right took two corrections, and **the first version of it stated a
conclusion that was wrong**. Both are recorded because either one silently produces an
authoritative-looking diff made of noise:

- **The list is VIRTUALISED.** `innerText` holds only the rows currently rendered, so scrolling to
  the top and reading once returns the oldest screenful and drops everything between. The first run
  did exactly that and reported two messages permanently lost. They were not - the peer had both.
  The collector now reads at every scroll position and accumulates.
- **The two windows do not coincide, and deriving the bound from the data does not fix it.** Each
  side loads whatever its scrolling reached, so a marker absent from one list may simply be older
  than that side went. Bounding to "the newer of the two oldest markers" still makes the answer
  depend on how far each run happened to get - **two consecutive runs disagreed**, one calling a
  dozen messages lost that the other reconciled. The window is FIXED (`RECON_WINDOW_MIN`, 90 min by
  default) and each side must hold at least one marker OLDER than it, which is the only evidence it
  covered the range. A diff reported without `covered` **and** `trustworthy` is not a result.

**A diff between unequal windows looks authoritative and is noise.** No per-check verdict substitutes
for reconciliation: it is what found WP-LOSS-1 and WP-ECHO-1, and both were invisible to every check
that was passing at the time.

---

## Reading a repair on the wire

The repair mechanism is **invisible to the network panel**: the diff travels as encrypted MLS
application frames, so the server sees one HTTP call and nothing else. The whole negotiation is
observable only in the CONSOLE. The design is in
[chat > pooling history between devices](frontend/modules/chat.md); this is the map from that design
to what a run can grep.

The only server-visible seam is `POST /api/mls/history-request` (`messaging.controller.ts`), which
elects one online member and relays, logging `FORWARDED target=…` or `NO_PEER_ONLINE`.

| Console prefix | Emitted by | What it tells a check |
| --- | --- | --- |
| `[HISTORY_REQ]` | requester + responder | the whole negotiation, both ends |
| `[HISTORY_DIGEST]` | requester broadcast, responder receipt | leg 2 arrived, and in which mode |
| `[HISTORY_PULL]` | responder -> requester | the REVERSE direction (the requester holds more) |
| `[HISTORY_BUNDLE]` | responder | what was actually shipped, filtered by id |
| `[MLS]` | `setupMessageHandler` | the escalation from a decrypt failure into the diff |

Four lines decide a verdict, and each says something different:

- `…: N to send, M to pull (identical stores)` - **the diff RAN**. This is the success line.
- `no digest from <identity> … - sending the whole store` - **the fallback fired.** Not a failure,
  but the run did not test what it meant to: the `HISTORY_DIGEST_GRACE_MS` rendezvous lost, so this
  is the old full dump wearing the new mechanism's name. Re-run it.
- `store unreadable - staying silent so another member answers` and `nothing to add and we are
  awaiting history too - staying silent` - a **deliberate** silence.

That last one carries a rule of its own: **a responder that stays silent looks exactly like a
responder that never got the request**, so a check asserting "no repair happened" must read the
responder's console too, never only the requester's.

Two further facts a HEAL verdict depends on:

- **The digest logs its MODE, and the mode is part of the verdict.** `ids, N id(s)` is an exact diff;
  `range, N slice(s) at depth D` is the size fallback, which resolves to a slice of the **id space**.
  A run reporting `range` exercised a different code path from one reporting `ids` - say which.
- **A responder is elected at RANDOM** among all online devices except the requester's own
  (`messaging.service.ts`), so every run must record **which device answered**. Two runs of one check
  can exercise two code paths on two machines, and the greener verdict is the one that says less.

Since there is now exactly one repair, any repair observed **is** the diff. What replaces the old
"which mechanism was that" question is a quantitative one every HEAL check must answer instead:
**how much traffic did the repair cost?** The deleted rung was a broadcast (~450 frames/min for over
ten minutes, repairing nothing), so a run whose frame rate does not fall back to the ordinary send
rate has found something.

---

## Environment traps that read as application bugs

These are not faults of judgement - they are platform behaviours that will be mistaken for defects
by anyone who has not met them.

- **Chrome discards every input event on a page it considers hidden**, and native occlusion detection
  marks a fully covered window hidden while `windowState` still says `normal`. Hence the
  `--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows` launch
  flags. A backgrounded tab must be made by focusing another **tab**, never by covering the window.
- **Only one OS window can have focus**, so two browsers cannot both report `hasFocus: true`. A check
  that asserts focus on both is asserting something impossible.
- **`am force-stop` is NOT "the user killed the app".** Android's STOPPED state cancels every FCM
  broadcast until a manual launch, so any push-dependent check must use a swipe from recents or
  `am kill`.
- **CDP's Network domain is BLIND to the app's own requests on mobile**: `hooks.client.ts` swaps
  `window.fetch` for the Tauri plugin's Rust client. Record from **inside** the page, inject failures
  there too, and keep such navigation client-side or a reload takes the patch with it.
- **An offline RECEIVER cannot be faked in the browser.** `emulateNetworkConditions` fails new
  requests in ~10 ms and the receiver still renders the message; only the SENDER side is faked
  faithfully. A true offline receiver needs the phone's radios
  (`svc wifi disable` + `svc data disable`).
- **`window.open` returning `null` is not proof of a blocked popup** - the spec permits `null` for a
  cross-origin window that did open.
- **Clicking through to an external app backgrounds the WebView**, which throttles it, so every read
  taken after that point is against a frozen page.
- **`tail`-piped output buffers until EOF**, so a progressing job looks hung.
- **`logcat -b all` is the whole PHONE, not the app.** Any filter over it must be scoped to the app's
  pid (`adb shell pidof fr.emse.canari`) before it is scoped to a word. An unscoped search for
  `forbidden` - looking for a Tauri capability rejection - counted **26** of them, every one the modem
  printing `Received Forbidden PLMNs`, and would have reported a colleague's storage panel as broken
  because of the SIM card.
- **An install can succeed over a WebView that then serves a cached page**, so a run can measure the
  previous bundle while every gate is green. Compare the loaded `_app/immutable/entry/*.js` names
  against the local build output - and read them from `performance.getEntriesByType('resource')`, not
  from `script[src]`: SvelteKit boots from an inline module, so a selector-based version of that
  assertion finds nothing and silently asserts nothing.
- **`Log.enable` and `Runtime.enable` REPLAY what the page buffered before you attached.** A probe
  that connects, enables, reloads and counts attributes the PREVIOUS session's errors to the reload
  it just performed. Measured 2026-08-13: 29 `SecretReuseError` reported for a fresh boot, every
  sample timestamped 35 minutes earlier. Take a cutoff instant before the reload and discard every
  event whose `timestamp` is at or below it.
- **A reload DESTROYS the execution context the Runtime and Log agents were enabled against**, and
  events stop being delivered for the new document - so the same probe then observes almost nothing
  and reports a silent, healthy client. The tell is the volume: 3 classified events across a whole
  app boot is not a quiet client, it is a detached agent. Re-send `Runtime.enable` / `Log.enable` on
  a tick across the observation window; both are idempotent, and the cutoff above already filters
  the duplicate replays that re-enabling produces.
- **The phone's message store is NOT IndexedDB, and reading it there reports the phone as wiped.**
  Measured 2026-08-13: on A1 the `CanariDB_<hash>` database exists with exactly the expected
  `conversations` / `messages` / `outbox` stores, and all three count **0**, while `/chat` lists a
  full conversation list on screen. The stores are present and empty because the WebView creates the
  schema; the data lives in the native (Rust/SQLite) store. A probe that counts IndexedDB on the
  phone therefore "proves" a total data loss that has not happened - and it will do so most
  convincingly right after a reinstall, exactly when a wipe is plausible. Assert against the SCREEN,
  or against the native store, and never carry a browser-shaped store probe over to the device
  unchanged.
- **A conversation looked up by NAME is ambiguous once the campaign has created test groups**, since
  a group containing the peer matches the peer's own name. Harmless for a check that only needs
  *some* group, wrong for anything asserting about the DM - resolve the id, and report which
  conversation the run actually used.
- **Postgres stores UTC while the prod host is `Europe/Paris`**, so a DB timestamp is two hours
  behind the wall clock a test just wrote down. Both are correct; convert, and never "fix" the
  server clock.
- **A virtualised count needs a FRESH MOUNT and the max over repeated polls**; a count taken while
  rows are still loading is non-monotonic and undercounts.
- **A baseline needs a polled budget, not a fixed wait.** A fixed sleep after a send reported a
  healthy link as lossy.
- **A conversation-scoped banner only renders inside `ChatArea`**, and its phase store is in-memory,
  so "no banner" is meaningless unless the check asserts the conversation is open **and** the
  observation window spans a fresh attempt. After a reload, "no banner" is guaranteed and proves
  nothing.
- **THE PIN GATE ONLY MOUNTS ON `/chat` AND `/communities`, so a LOCKED client reads as unlocked
  everywhere else.** Any launch, kill, reboot, radio cycle, `install -r` or self-restart re-locks the
  encryption PIN, and a locked client decrypts nothing and ACKs nothing - every number taken from it
  is wrong, and it never says so. `input[type=password]` is doubly wrong: the mobile shape is a
  KEYPAD with no input element at all. `state.mjs` therefore answers `LOCKED` / `unlocked` /
  `unknown (gate not on this route)` - `unknown` means *run `pin.mjs`*, which is idempotent, so
  running it when it was not needed costs nothing while skipping it costs the whole measurement.
- **`client()` turns FOCUS EMULATION on, and an emulated-focus page is pinned `visible`.** That is
  what lets three clients each be "the focused window" at once, and it silently defeats every attempt
  to background one: `window.open` really does open a sibling tab and the page stays `visible`
  anyway. `background()` now toggles it off for the duration; closing the sibling also does not
  necessarily re-select the app, so the restore asks for `Page.bringToFront` explicitly. A failed
  attempt must close its own tab, or the next run inherits a window full of stale `about:blank`.
- **A node script holding an open CDP socket never exits**, so a PowerShell pipeline that buffers
  (`| Select-Object -Last N`) prints NOTHING and reads as a hang - after the script has already
  computed and printed a perfectly good answer. Redirect to a file and read the file. This cost three
  runs in one session before it was recognised.
- **The message store is CIPHERTEXT at rest**, so searching its rows for a marker string finds
  nothing whether or not the message is there: only `id` and `conversationId` are plaintext. A probe
  written that way is VACUOUS, not negative - and it will happily "confirm" a loss that never
  happened. Assert on the rendered pane for presence, on id sets for reconciliation.
- **A frozen Chrome renderer still answers `/json/list` over HTTP** while every `Runtime.enable`
  times out, so the browser looks alive and each individual check looks broken. Opening a fresh tab
  on the same profile does NOT help - the whole browser process is the thing that is wedged. Relaunch
  it with `launch.mjs`, whose profile is on disk, then re-enter the PIN.
- **The phone's devtools socket is named after the PID and the app restarts on its own**, so a
  forward left from earlier in the session points at nothing while the app is perfectly healthy - and
  a process with no WebView (the background push handler) is *also* a valid `pidof` answer that has
  no devtools socket at all. Re-derive it (`a1forward.mjs`), and treat "no targets" as "re-forward",
  never as "the app is down".

---

## Where a result goes

- **PASS** -> one row in the [dashboard](cross-client-testing.md), with the build it ran against.
- **FAIL** -> a Work Package in `CLAUDE.md`, severity per its rules, **with the captured log inline**.
  A durable marker written without its evidence is legacy.

The campaign is not done when the tables are full. It is done when every FAIL is either a Work
Package or a fixed commit, and the dashboard says which build produced each verdict.
