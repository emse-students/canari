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

## The sixteen rules

Ordered by how expensive it is to break them.

### 1. A verdict must never be computed over a projection of its own evidence

`heal-web.mjs` filtered the console through a **display** regex, then ran its matchers over the
**filtered** text. A line the matcher accepts but the filter drops is invisible, so the check
reported `escalated=false` on a run whose repair had demonstrably run.

A capture filter is presentation. The verdict reads **everything** the run produced, and only the
report is abridged. If the two must share a regex, the verdict's is the superset - never the
other way round.

**A CHANGE LOG IS A PROJECTION TOO, and it is the one that reads like raw evidence.** `synboot.mjs`
records a mark only when the banner or the layout offset CHANGES - which is right, because a
histogram of samples cannot tell one 0.7 s appearance from a flicker. Its first verdict then counted
marks in the post-startup window as if they were samples and required at least one, so an offset that
never moved emitted nothing and scored as `FAIL` on the run that proved the fix. The evidence was
perfect and the verdict inverted it. **When the record is transitions, the verdict must be stated in
transitions** - "zero changes after ready", never "one distinct value after ready".

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

**THE CHEAPEST POSITIVE CONTROL IS A CLIENT STILL RUNNING THE OLD BUILD, AND THE MIXED FLEET HANDS
IT OVER FREE.** `synboot.mjs` reported zero banner appearances on both web clients after WP-BANNER-1,
which is the verdict wanted and therefore the one to distrust: a probe whose selector had rotted
would say exactly the same. A1 settled it without any extra work. The phone serves the bundle inside
its APK (`frontendDist` is `../build`), so a deploy never reaches it, and its build predates the fix -
so the SAME probe run against it caught the banner rising at 4 601 ms, 26 px high, held for 4 s.
The instrument discriminates, so the zeros mean something.

Two things came out of that control which the intended measurement could not have produced. The
banner did NOT move `mainTop` on A1 (107 px throughout), so the 29 px displacement that delivered a
click to the wrong button is a DESKTOP-layout consequence, not a universal one. And the verdict was
counting marks rather than comparing offsets - two marks reading the same 107 scored as two
movements - which is rule 1 again in a third dress: the mark fires on a change in the WHOLE probe,
so only the field being judged may be compared.

**Where the defect can be re-created, the check should re-create it.** WP-RELOAD-DL-1 asserts that a
reload does NOT navigate - and a build with deep links entirely broken passes that too. Deleting the
one key the fix relies on (`sessionStorage['canari:deeplink:handled']`) and reloading again brought
the replay straight back, which is what turns "nothing happened" into "the guard held". A PASS whose
failure you cannot produce on demand is the weakest kind there is.

**AND WHEN THE RE-CREATION IS A RACE, THE CHECK MUST ASSERT THAT IT WON IT.** `burn.mjs` sends, waits,
reloads, and asserts the next message arrives. Its premise is that the reload landed inside the
checkpoint window - and a run that MISSES the window delivers that message too, identically, proving
nothing. First run, 2026-08-14, at the 300 ms the original defect was measured at: the checkpoint had
already landed, and a check that reported only "delivered" would have been a green light for a repair
that never ran. The window had narrowed to under 60 ms since that measurement, because an unrelated
fix had made the write faster. So the premise is read and reported separately from the result, and a
run that failed to reproduce itself is `INCONCLUSIVE` - never `PASS`.

**Pick the witness that does not depend on listening at the right millisecond.** The repair prints a
line, and the obvious check greps for it. But a reload that does not raise the PIN gate starts
initialising before a CDP session can re-attach, so on the run that PASSED the line was missed
entirely (`burnedLine: null`) while the repair had demonstrably happened. A verdict resting on that
capture would have read "no burn" and been believed. The counters the repair consults are DURABLE and
can be read on either side of the reload at leisure: deficit before, deficit after. **Where a
mechanism leaves both a log and a state, the state is the witness** - the log is how a human finds it,
not how a check proves it.

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

### 12. A CAP IS NOT A COUNT, AND A SUMMARY AS LONG AS ITS SOURCE IS UNREAD

Two ways a triage list lies about its own size, both met on 2026-08-14 within an hour of each other.

**A truncated bucket reported its truncation as its measurement.** `srvlog.mjs` kept
`errors.slice(0, 40)` and then printed `errors.length` - which is 40 whether the window held forty
errors or nine hundred. The summary line a reader uses to decide *whether to look at all* was
therefore incapable of ever saying "this is worse than you think". The window that finally got read
held **1 154** unexplained gateway lines behind a `40`. Every truncated bucket now carries its own
`…Count` taken before the slice.

**And a list of 1 154 lines is not read by anybody**, so it may as well be empty. Collapsing each
line to its *shape* - text with every identifier replaced by its kind - turned those 1 154 into 33
sentences, and the whole seven-service window into 72. That is a list a person finishes.

The catch is that **the normaliser then decides how big the work looks, so it is load-bearing and it
must be tested.** Its first draft matched ids at sixteen hex characters, so eight-character
correlation ids survived and 287 copies of one sentence counted as 287 distinct shapes - a summary
exactly as long as the thing it summarised. Its second bug was ordering: the device rule ran after
the id rule, so `web-<id>-suffix` had already stopped looking like a device by the time anything
looked for one. Neither has a symptom on a live window; both are pinned in `srvclassify-selftest.mjs`
now, next to the assertion that genuinely different sentences must still *not* collapse.

### 13. AN INSTRUMENT'S OWN LIMIT ARRIVES WEARING THE SYSTEM'S FAULT - and it bites the busiest subject first

`chat-delivery-service` reported `unreachable: spawnSync … ENOBUFS`, which reads as a broken tunnel
or a dead container. It was neither: Node's default `maxBuffer` is 1 MB, and that service writes
11 824 lines a day, so any window wide enough to be interesting exceeded it. **The busiest service on
the platform was the one whose logs could never be read, and the reason looked like infrastructure.**

The general shape is worse than the instance. A limit that scales with the subject's activity fails
*precisely* on the subject that has the most to say - the quiet services all read fine, so the
instrument looks healthy in aggregate. Anything that reads a variable-sized answer needs its ceiling
chosen against the loudest case, not the median one.

What saved this from being silent is that `srvReport` files an unreadable service as `unreachable`
and breaks `clean`, rather than returning `[]`. **An unreachable service is not a quiet one**, and
the substitution of one for the other is the single failure this harness exists to refuse.

### 14. AN OBSERVATION WINDOW MUST KNOW WHETHER ITS SUBJECT WAS REPLACED DURING IT

The gateway logged five `Connection reset without closing handshake` errors inside three
milliseconds, across four different users. Nothing a client does explains that. The container
timestamps did: `frontend-ssr` and `frontend` were recreated at 12:45:20.5, and the five resets are
at 12:45:19.892-.895 - the tear-down of the old container, 0.7 s earlier.

Two consequences, and the second is the general one. First, an operational fact worth knowing:
**nginx is the single public entry point, so a frontend redeploy severs every proxied WebSocket on
the platform at once.** Second, and the reason this is a rule: a run whose window straddles a deploy
will attribute the deploy's fallout to whatever it happened to be measuring. So a service *starting*
inside the window is classified `notable` and never benign - `Listening on http`, `Nest application
successfully started`. The window must be able to say "I was rebuilt under myself".

The same instant answered a question the passes could not: the three MSG passes ran 12:22-12:45 and
the fix under test deployed at 12:45:20, **after all of them**. `webstate.mjs` then showed both tabs
still on `__sveltekit_1prkb1y` against a served `__sveltekit_1ywe1to`. Re-running without reloading
would have measured the old bundle a fourth time and called it a verification.

#### The same rule pointed at the CLIENT - where the replacer is the check itself

READ was the first phase whose runner classified console lines at all, and on the run that wired it
in, READ-1, READ-2 and READ-4 each came back `PASS-DIRTY` on exactly one `Network.webSocketClosed`,
with `[WS] Disconnected. Code: 1006, Reason: no reason` beside it. 1006 means no close frame was
received - the signature of an intermediary dropping a connection - so it read as a live socket dying,
which is WP-RECONNECT-2's exact shape.

**The first attribution was wrong, and the probe that produced it was not.** `wsclose.mjs` reported
that the closed socket had never been created inside the window, which is true and correctly
measured. The conclusion drawn - that the window had inherited the *previous* page's close - did not
follow, because that probe never performs the check's SECOND navigation. `gotoWatched` was built on
it, delayed each window until the new page's handshake, and the next run came back identically dirty.
**A probe answers the question it was written to answer**, which is the client-side twin of "a column
is only evidence for the question it was written to answer": the measurement was reusable, the
inference was not.

What settled it were two CONTROLS rather than more evidence of the same kind:

- `wsidle.mjs` left W1 **and W2** alone for eight minutes, touching neither - same instrument, two
  subjects, one window. **Zero closes on both.** That kills the idle-timeout-on-the-path reading
  outright: nothing drops an untouched socket, so the event is caused by something the check does.
- `navclose.mjs` then navigated three times and counted: three main-frame `Page.frameNavigated`,
  three `webSocketCreated`, three `webSocketClosed`, three `Code: 1006`. **One document replacement,
  one close, exactly.** `openDM` is `goto` is `Page.navigate`, so each of those checks was tearing
  down its own socket and then reporting the teardown as dirt.

Two things follow, and neither is "ignore socket closes".

**Forgiveness is bounded by a counted proof.** `ignoringNavigation` forgives at most
`documentsReplaced` closes and no more; the (N+1)th still breaks `clean`, so a live socket dying stays
visible. The tempting rule - *ignore a close whose open I never saw* - would have silenced precisely
the class the campaign exists to catch. Note also that the obvious counter is the wrong one:
`Runtime.executionContextsCleared` fired **six** times for three navigations, and only main-frame
`Page.frameNavigated` is 1:1.

**And the window opens BEFORE the navigation, not after it.** `gotoWatched` now watches first and
navigates second - the inverse of what it did when it was written. A window that opens late is a
window blind to the boot it skipped, and the boot is where a startup defect lives.

An application "fix" fell out of this, shipped, and was **reverted the next day as inert** - the
story is rule 17. The harness rule above is unaffected either way: it attributes a close to a counted
document replacement, and a document being replaced still closes its socket however politely it does
so. **`ignoringNavigation` is what actually removed this dirt**, and it was the whole of the fix.

### 15. A CHECK MUST ESTABLISH ITS PRECONDITION, AND WHAT ESTABLISHES IT BELONGS IN THE SHARED LAYER

TYPE-4 asks that an **offline** peer sees no typing indicator and gets none replayed when it returns.
It set `Network.emulateNetworkConditions({offline: true})` on the peer, waited, and asserted the
indicator was empty. It failed, and the failure was entirely its own: that setting fails NEW requests
and leaves an ESTABLISHED WebSocket open, so the peer was never offline, took the frame live exactly
as it should have, and the check reported a delivery defect it had manufactured.

The precondition was never established, only intended - so **the one outcome the check could not
produce was the true one**. An assertion of the form "while X, not Y" is worth nothing until X is a
fact the system under test agrees with. Here that fact is the gateway's presence key: `cutHard`
closes the socket as a dropped connection would, `awaitOffline` waits for the key to go, and a peer
that never goes offline makes the verdict **INVALID**, never `FAIL` - the difference between "the app
is wrong" and "I did not manage to ask".

**The sharper half is that none of this was new.** `msg9.mjs` had measured the same trap on
2026-08-13 - sixty seconds of "offline" with the presence key refreshed the whole way through - and
written it up in its own header, where no other check could reach it. A fact that costs a diagnosis
to learn belongs in the shared layer the moment it is learnt; left in the file that paid for it, the
next check pays again. `cut()` vs `cutHard()` is now the seam that carries it.

Two smaller instrument faults came out of the same phase, both worth naming because neither is
caught by a green gate:

- **`type.mjs` computed five verdicts and read no console at all.** The campaign's rule that
  observation is part of a check was stated globally and simply not implemented in one phase file, so
  every TYPE pass asserted that an indicator appeared and said nothing about what the two pages
  logged while it did. A rule enforced by remembering to write it is not enforced.
- **A syntax check is not a runtime check.** A comment inside an evaluated template literal quoted an
  identifier in backticks; the backticks closed the literal, leaving `template / identifier`, which
  is valid JavaScript. `node --check` passed and every run threw `ReferenceError` at the division.
  Proving a harness edit means RUNNING it, exactly as proving a native build means running it.
- **A precondition with TWO legitimate landings may not be written as one of them.** `synboot.mjs`
  waited for the PIN modal after a reload, because that is what a reload usually lands on. With
  "Rester connecte" ticked the vault device key path restores the client with no modal at all, so the
  wait burned its whole 30 s deadline and the next line then reported the app **ready in 2 ms** - a
  boot that had in fact finished 29 s earlier. Nothing failed; the check simply measured its own
  wait and printed it as the application's number. Race the landings and let the answer say which
  one happened.

### 16. A CLICK IS PROVEN BY THE EVENT, NEVER BY THE GEOMETRY AROUND IT

TYPE-5 failed roughly one run in ten with the create-channel modal on screen, at coordinates
`stableCentreOf` had verified belonged to the `general` row moments earlier. Both readings were
honest and both were useless: a hit test **before** the dispatch and a screen read **after** it
describe moments the click did not happen, and neither can tell a click that landed on the wrong
element from a right element that did nothing.

The witness is the event. `realClick` now arms a capture-phase listener before dispatching and
returns what actually received the click, which named the culprit on the first occurrence:
`{"tag":"BUTTON","text":"Ajouter un canal"}` at the row's own centre. The cause was an application
defect - a status banner in the layout flow appearing at ~480 ms and vanishing at ~2 286 ms, moving
everything 29 px between the hit test and the dispatch - and no amount of re-proving the geometry
would have found it, because the geometry was correct every time it was read.

Two lessons, and the second is rule 15 again from the other side:

- **Verify the effect you asked for, not the conditions you asked under.** A coordinate that
  hit-tests correctly is a precondition, not a result.
- **Then establish the precondition properly**: `awaitAppSettled` waits for a STATE - no status
  strip up, `main` at the same offset for three consecutive reads - not for a duration. It lives in
  `chat.mjs`, so every check that clicks inherits it rather than each learning the trap alone.

### 17. A FIX MUST NAME THE OBSERVER WHOSE SIGNAL IT IMPROVES, AND THAT OBSERVER MUST BE ABLE TO SEE IT

Rule 14 found that every `goto` closes its own socket and reports `1006`. The harness fix was right.
The APPLICATION fix that shipped beside it - `closeForUnload`, closing with `1001 - going away` so a
routine navigation would stop spending the code that means *an intermediary dropped the link* - was
**measured inert the next day and reverted**. Nobody could ever have seen it:

- **The client cannot.** `CloseEvent.code` carries the code the SERVER sent back in its half of the
  closing handshake. At unload the document is destroyed long before a reply can arrive, so the
  browser fills in `1006` whatever code the page asked for. Measured on a tab positively confirmed to
  be running the new bundle: **3 navigations, 3 x 1006** - identical to before the fix.
- **The gateway cannot either.** It matches the app's own `{"type":"disconnect"}` frame with
  `handle_disconnect(...); break` (`chat-gateway/src/handlers.rs`), so it has already left its read
  loop when the close frame arrives. Its `Client closed connection: {:?}` line is unreachable for any
  client that announces itself: **0 occurrences against 12 explicit disconnects in 25 minutes of
  production traffic.**

So the change was a no-op with an interface method, four implementations and a test behind it, and
its CHANGELOG entry promised users a reduction in something that never reduced. **Before writing the
fix, name the log line, counter or screen that will read differently afterwards, and check that
something actually reaches it.** Here the honest answer was already available: the `disconnect` frame
tells the gateway everything a close code would, and earlier - so there was nothing to add.

Two corollaries, both paid for on the same day:

- **A discriminator that fires identically with and without the change discriminates nothing.**
  `unloadframe.mjs` counted the `disconnect` frame at each navigation and called 3/3 a PASS for the
  fix - but `sendDisconnect` PREDATES the fix. W2, on a bundle positively lacking the new chunk,
  emitted the frames too. It only looked decisive because it was run first on the one client that
  happened to have the change. **Run the negative control before believing the positive one.**
- **A NAVIGATION DOES NOT PICK UP A DEPLOY; ONLY A CACHE-BUSTING RELOAD DOES.** W2 served the old
  entry chunk across three `Page.navigate` calls made after a successful deploy. Any check re-run
  "on the new build" without `Page.reload {ignoreCache:true}` is measuring the old one - rule 9 with
  a sharper edge. `bundle-id.mjs` reads the loaded chunk hashes off the resource timeline and answers
  it directly; a fingerprint that comes back EMPTY compares equal to itself and will happily report
  "unchanged" for ever, which is how the first attempt at this reported `INCONCLUSIVE` for a reason
  that was not the true one.

---

### 18. A CHECK THAT REPAIRS THE CLIENT MUST WAIT FOR ITS OWN REPAIR - a single sample right after it measures the instrument

`run.mjs`'s in-run preflight repairs a client parked on `/communities` - where the PIN gate does not
mount, so readiness reads `unknown` - by sending it to `/chat` with a full document navigation. Every
other repair in that loop then waits on a DEADLINE (`settle`, 3-20 s). The gateway-presence check did
not: one `presence.mjs` sample, taken immediately, and a non-zero exit blocked the phase.

**MSG-6/7 was `BLOCKED` on five passes out of five** on a phone that was working perfectly. Measured
directly by parking A1 and polling:

| after the navigation | gateway |
| --- | --- |
| 4 879 ms | OFFLINE |
| 7 828 ms | OFFLINE |
| **10 832 ms** | **ONLINE**, still on `/communities` |

The route was never the problem - the page it sits on is irrelevant, the reconnect cost is
everything. A document navigation destroys the socket with the document, so the read that follows
answers about the harness's own action. It now polls to a 25 s deadline and prints only the last
attempt: a client already connected answers on the first sample and pays nothing, and a client
genuinely absent still fails - the diagnostic value is untouched.

The general form, and the reason this is not rule 15 again: rule 15 is about a precondition the check
never ESTABLISHED. Here the precondition was established, correctly, by the check itself - and then
read before the system had finished responding to it. **Anything you did to the client is a
transition; give it the same deadline you would give the application's own.**

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

**The server observer now meets that bar and is tested like the other two.** `srvlog.mjs` classifies
every application container's `docker logs` over a run's own window into the same buckets, `run.mjs`
calls it at the end of every pass so the bar is not enforced by somebody remembering to type a
command, and `node srvlog.mjs --since <t> --shapes` collapses `unexplained` and `notable` to distinct
sentences for triage. Its buckets have one addition the client's classifier does not need:
`expectedErrors`, for errors that are real, named and not defects - `WebSocket protocol error:
Connection reset without closing handshake` is the gateway describing a *client* that vanished
without a close frame, which every reload this campaign performs produces. Forgiven from the gate,
kept in the record, per rule 11.

The first fully classified window, 2026-08-14 12:22-12:45Z: **8 534 lines across seven services, zero
unexplained**, five notable shapes. Two of those five were open questions rather than noise -
`FALLBACK_MEMBERS_CACHE` fired on **279 of 279 sends**, and five `NO_PEER_ONLINE` history asks were
requests for repair that nobody could answer.

**The first of the two turned out to be a defect, and refusing to file it as routine is the whole
reason it was ever read.** It was kept out of `BENIGN` on the grounds that a 100 % rate may be the
design but nobody had said so; it was not. No caller has ever populated `recipients`, so the branch
calling itself a Redis cache miss was the only path a proto send has, for a cache `sendMessage`
never reads - and the fixture in `messaging.durability.spec.ts` was supplying recipients through
that same dead field, so five green assertions measured a branch production never takes. The
narrative is on [chat-delivery](services/chat-delivery.md); what generalises is the rule: **a rate
is a measurement against a population, and a name is not evidence.** Its replacement,
`MEMBERS_CACHE_REPAIRED`, is matched by no rule at all, on purpose - a defect report a bucket
forgives is one nobody reads.

`call-service` deserves its own note: **0 lines
in 24 hours**, its last entry the startup line from two days earlier - so the CALL phase, when it is
written, will have no server-side observer at all until that service logs something.

Two rate rules follow. **A claim about frequency needs a denominator** - "it fires on every launch"
is a measurement (N cold starts, N observations), never an impression from one occurrence. And **a
measurement taken on a locked client measures nothing**: entering the PIN is part of starting a
client, not a step before the interesting part, because MLS does no work at all until it is unlocked.
The app's side of that contract is a property worth asserting rather than assuming: **it must not
attempt MLS work before a PIN has been entered** (a stored PIN or biometrics count as entered), so
MLS activity observed before the unlock is a defect, not a timing quirk.

#### Three classifier faults, and why each was a near-miss on an existing rule

Taken from the MSG run of 2026-08-14 17:17-17:38Z, where they were the only dirt. None was an
application fault, and none was a *missing category* - each was a rule that already existed failing
to recognise a member of the population it was written for. That is the shape to expect: **three of
the last four classifier additions were near-misses on an existing rule, not new categories.**

- **A 200 called a failure.** `badHttp` decided on CDP's `r.failed` BEFORE consulting the status, so
  a response that arrived with a 200 and whose body load was then cancelled was filed as a failure -
  breaking `clean` and taking the run's exit code with it. **A status code is an ANSWER**: a request
  that got one is judged on it, and only a request that got none is a transport failure. `watch.mjs`
  now says so, with four HTTP cases in `classify-selftest.mjs` pinning it, including that a 502 on
  the same endpoint still breaks `clean`.
- **A report missed by a space.** The hourly `[CRON] reportQueueDepth:` is camelCase, and the rule
  spelt it `queue depth|QUEUE_DEPTH`, matching neither form - so the one line that reports the
  fleet's delivery backlog landed in `unexplained` once an hour. A matcher tests one SPELLING
  (rule 6); a rule naming a log line must be written against the line, not against its subject.
- **A crawler's `[404] GET /sitemap.xml.gz`**, the same family as the `/sitemap_index.xml` guess
  already classified. Spelt out per path deliberately, with an assertion that a 404 on a route we DO
  serve stays unexplained - an allowlist of what may be forgiven, never a pattern for what to ignore.

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

Both corrections above became moot on 2026-08-11, when the collector moved from the rendered pane to
the STORE - a window onto the history is not the history, and on the test DM the pane read 60 rows
of 1 804 and called the empty difference a success. The store answers the same question in one read,
for a conversation of any length.

### The phone was outside it until 2026-08-15, and the fix was choosing the right route

`recon.mjs` reconciled WEB clients only, and said so - a native client keeps its messages in SQLite
behind Tauri, while the `CanariDB_*` IndexedDB it also carries is a permanently empty vestige. **That
left the device most likely to lose a message as the one device the loss instrument could not see**:
the phone is the one that backgrounds, takes pushes, and pays 1.5 s per checkpoint.

Two obvious routes were rejected for stated reasons, and the reason is the transferable part:

- **`adb pull` the database.** It works. `canari_<uid>.db` is 2.4 MB of a REAL account's
  conversations, including people who never agreed to be in a test harness, so copying it to the
  host is the credential leak `mlsdb.mjs` refuses in its own header - a debugging motive does not
  change what the bytes are.
- **Query it in place with `sqlite3`.** There is no `sqlite3` binary reachable under
  `run-as fr.emse.canari`.

**So ask the application, which already holds the file open.** `@tauri-apps/plugin-sql` exposes
`plugin:sql|select` over IPC, and IPC is callable from CDP - so the query runs on the device and
**only ids and counts come back**. `cipher_text` is never named in it. The database is keyed
`sqlite:canari_<userId>.db` and the id is taken from the page's own `mls_send_ledger_<userId>` key,
so no account identifier is typed on a command line or committed. The RUNTIME picks the reader, not
the port or the label, so a client moved to another port cannot silently take the wrong one.

First run: **RECONCILED across all nine shared conversations, id by id, `onlyW1: 0` and `onlyA1: 0`
everywhere**, including the 4 282-message DM, and no one-sided conversation at all.

The general lesson is not about SQLite. **When the data cannot be moved and cannot be read in place,
the process that already has it open is the third option**, and it is usually the one that also
happens to be the only privacy-preserving one.

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
