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

## The rules

Grouped by what they protect, and ordered inside each group by how expensive they are to break.

### What a verdict may rest on

#### 1. A verdict must never be computed over a projection of its own evidence

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

#### 2. Every action asserts its own post-condition - and the post-condition is the RIGHT state, not a changed one

The two halves are one rule because they fail together: a check that cannot prove its action took effect will happily accept any effect at all.

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

**"Did the state change" is almost never the assertion. "Did it change into the RIGHT state" is**

The corollary of the last item above. A pinch check asserted that the scroll position moved; it
moved, and the page had zoomed about the wrong point, which is the entire defect the check existed
to catch.

**Validate every check as a NEGATIVE CONTROL against the unfixed build before its green means
anything**, and set its tolerance from those two measurements rather than from taste. A check that
has never been seen to fail is not a check.

#### 3. Assume a green check is wrong until its evidence says otherwise - and a FAIL too

A FAIL is not evidence about the application until the fixture and the selector have been ruled out.
Two examples on opposite sides:

- A media check passed against a fixture whose PNG CRCs were invalid - it was never rendering
  anything.
- `check-feed-retry` reported FAIL against a feed that was visibly rendering posts, because it
  counted `article` / `data-post-id`, neither of which the feed emits (`PostCard`'s root carries
  `group/card`).

**A locator failure does not bias the verdict in a predictable direction**, which is why it cannot
be discounted as "conservative".

#### 4. THE ABSENCE OF A FAILURE IS NOT EVIDENCE OF SUCCESS - prove the path was EXERCISED

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
DEBUGGABLE, one of the few things a debug build is BETTER for (rule 17).

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

**AND A WHOLE PHASE CAN BE THE PATH THAT NEVER RAN.** Found 2026-08-16 by noticing that a run
announcing NOTIF-10 had not cut the phone's radios: `notif.mjs` selects ONE check from `argv[2]` and
defaults it (`|| '4'`), `notif7.mjs` does the same (`|| 'bg'`), and the manifest listed both bare. So
`run.mjs NOTIF` ran two of five checks and reported the phase. Sweeping every manifest script for the
shape found two more, and one names itself: **`tab236.mjs` implements checks 2, 3 and 6 and ran only
2**, while `life.mjs` implements seven Android lifecycle states and ran only one. The manifest now
spells every argument out - NOTIF 2 -> 5 scripts, TAB 3 -> 5, LIFE 1 -> 6.

**A default is indistinguishable from a choice**, which is why nothing ever said so: no output
differs between "the phase asked for check 4" and "the phase asked for nothing and got 4". The
omission that must stay explicit is LIFE-5 - it REBOOTS the phone and the unlock afterwards needs the
pattern, so it is a human check named in a comment rather than a gap nobody can see. **A coverage
omission belongs in the manifest as a sentence, never as an absence.**

**A RUNNER THAT BUFFERS ITS CHILD'S OUTPUT UNTIL EXIT CANNOT REPORT THE FAILURE THAT NEVER EXITS.**
The same day and the same cause: every phase script announces its stages on stderr precisely so a
stall is distinguishable from slowness - `notif.mjs` says so in its own header - and `run.mjs`
collected the whole stream into a string it only wrote on `close`. Two `notif.mjs` processes sat
there for FOUR HOURS driving the same browsers as every other measurement of the day, and were found
by listing OS processes, not by the runner that owned them. There is now a heartbeat and a watchdog
that bounds SILENCE rather than work - set well past NOTIF-10's deliberate 600 s of quiet - and it
kills and ACCUSES rather than retrying, because a runner that quietly restarts a hung script hides
what it exists to surface. `STALLED` is reported as itself: a killed child otherwise reports a signal
and reads as an ordinary crash in its last statement.

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

##### The sharpest instance: a run that printed PASS while the branch never ran

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

##### The corollary for a PERFORMANCE verdict: fast and skipped look identical on a clock

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

### Reaching the thing under test

#### 5. RESOLVE A TARGET BY IDENTITY, NEVER BY GEOMETRY - and the DEVICE is part of the identity

A selector, a coordinate and an adb serial are the same question asked at three scales: WHICH one. Geometry answers it only until something moves.

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

**AN ANCHOR IS A CLAIM ABOUT THE PRODUCT, AND IT EXPIRES.** `PANE` located the open conversation as
the composer's nearest `<section>` - true of every conversation the product had ever had, until a
salon reserved for administrators started replacing the composer with the reason. The pane then read
`null` for a member who could still READ perfectly well, so `awaitMessage` reported `hasPane: false`
and COMM-7 failed on the ADMINISTRATOR's message: the harness saying "this client has no conversation
open" about a client watching one. **A conversation is a place where messages are DISPLAYED; being
able to write in it is a permission, and an anchor must not confuse the two.** Anchored on
`.chat-messages-scroll` since 2026-08-20. The general form: when a check locates X through Y, it has
asserted that Y is present whenever X is - so write that assertion down, and re-read it whenever the
product grows a state where it is false.

**A CLICK IS PROVEN BY THE EVENT, NEVER BY THE GEOMETRY AROUND IT**

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

Two lessons, and the second is rule 7 again from the other side:

- **Verify the effect you asked for, not the conditions you asked under.** A coordinate that
  hit-tests correctly is a precondition, not a result.
- **Then establish the precondition properly**: `awaitAppSettled` waits for a STATE - no status
  strip up, `main` at the same offset for three consecutive reads - not for a duration. It lives in
  `chat.mjs`, so every check that clicks inherits it rather than each learning the trap alone.

**A HELPER THAT COMPUTES ITS OWN COORDINATES INHERITS NONE OF THAT**, and the omission is invisible
until it misses. FWD ran 4 passes of 5 because `clickBubbleAction` grew its own dispatch instead of
going through `realClick` - so it had no hit test, no recorder and no parking, clicked blind, and a
miss surfaced ~15 s later as a missing dialog, indistinguishable from an application defect. Routed
through the shared primitive, the same failure now names itself at the click: `"Transférer" action
moved before the click: nothing clickable at the point`. **A second implementation of a shared
primitive is a second place for this rule to be un-learnt** - extend the primitive instead.

**AND THE SAME RULE FROM A THIRD SIDE: TWO IDENTICAL SAMPLES ARE NOT A PROOF OF REST.** They prove
only that the element was not SEEN moving. `stableCentreOf` polled a rect every 120 ms and returned
a point once two consecutive rounded centres agreed - which an entry animation satisfies twice over:
before it has begun to paint, and again after it has finished. A backgrounded tab does not advance
one at all.

Measured on 2026-08-16, and the number is the whole diagnosis: the delete-confirmation button was
clicked at `dx=0, dy=24` from its own centre, with `candidatesInDocument: 1` - **24 px is exactly
the amplitude of `Modal.svelte`'s `in:fly={{ duration: 220, y: 24 }}`**. The centre was taken at the
animation's start and dispatched after its end, so the point landed in the footer that HOLDS the
button, which has no handler. Nothing happened, and the check died 5 s later on "the dialog never
closed". Three checks were losing runs to it - MUT-7, MUT-8, MUT-19, both venues, ~1 call in 6 - and
five passes of attribution went to the wrong halves first: a mis-resolved selector, then a slow
delete, then the two motions that turned out too small to matter (`hover:-translate-y-0.5` is 2 px
over 150 ms, and `mousePressed` follows `mouseMoved` by milliseconds).

**The repair is a proof, not a longer wait**: `IS_MOVING_FN` asks the page whether the element - or
any ancestor, because a modal's `fly` is on the PANEL and its buttons are passengers - is under an
animation that will end. `getAnimations()` covers CSS animations, CSS transitions and Svelte
transitions in one answer, so no duration has to be guessed for any of them. `pending` counts as
moving: an animation created this frame has not painted, which is the exact window that lied.
Infinite animations are skipped - a spinner never settles, and waiting for one would report every
button near a loader as unfindable.

Two corollaries, both paid for here:

- **Closing the window is not the same as closing the hole.** The check and the click are two
  messages over a socket and can never be simultaneous, so a verified point is stale by
  construction. Removing round trips between them shrinks the exposure (`maxTouchPoints` was being
  re-asked on every click for an answer that cannot change, and is now cached per connection) but
  only the absence of motion makes it safe. The in-page atomic alternative - `element.click()` -
  is the one that must NOT be used: it skips hit-testing, hover and touch, so it would have passed
  straight through both the create-channel modal and the phone's touch-only activation.
- **A miss must accuse at the click.** `realClick` now resolves the intended element BEFORE
  dispatch and the recorder compares against it inside the listener - after the fact is too late,
  because a successful click usually destroys its own target, so re-resolving answers "gone" for a
  hit and a miss alike. It should never fire now; if it does, it is a motion nobody has named yet.

**AND THE PROOF HAD TO REACH THE HELPERS THAT COMPUTE THEIR OWN POINTS, which is the paragraph above
happening again within the hour.** A hovered action row, a reaction in the emoji picker and a tap in
the phone's action sheet have no selector - they are found by walking the DOM from a message row -
so they never went through `stableCentreOf` and inherited none of it. Fixing only `realClick` left
them clicking mid-animation, and the very first run that could see it said so: `the 🎉 click was
taken by "EMOJI-PICKER" (target was ANIMATING when measured)`. The picker was still opening.

`stablePoint` is `stableCentreOf` for a caller-computed point, and the reason it is one function is
that three of the four sites had already drifted apart: one retried, one did not, one threw on its
first read. **Its polling set is the lesson** - "not there yet", "covered by something" and "still
moving" are one animation seen at three moments, so all three are polled and only the exhausted
budget is a failure. `tapSheetIcon` was the starkest: it read a sheet that SLIDES UP from the bottom
of the screen, exactly once, with no retry at all.

One corollary about reports, paid immediately: after the wait was added, `clickReactionEmoji`'s
failure still printed *was the target animating* - a question the new code can only answer one way,
because the point it clicks is settled by construction. **A discriminator that can no longer take
two values is not a discriminator**, and leaving it in would send the next reader after the cause
that had just been eliminated.

**THE PHONE'S SOFT KEYBOARD MAKES COORDINATES LIE, SO A CONTROL REACHED AFTER A FIELD HAS FOCUS CANNOT BE RESOLVED BY GEOMETRY**

Arming MUT-18 - the first check in this campaign to drive a message's controls on the phone - cost
three runs, and only the first was about the thing being tested.

1. `realClick` on the edit form's Save: the click landed somewhere, the form never closed.
2. `activate` instead - the fix `fireComposer` already carries for the composer: `no element to
   activate: text=Enregistrer`, about a button a probe measured a minute later at 77x26 with its
   label spelt exactly that way.

Both are the same cause. Focusing the textarea opens Android's soft keyboard, which shrinks the
**visual** viewport while the **layout** viewport `getBoundingClientRect` reports keeps its height.
`RESOLVE`'s last filter is a hit test at the element's centre, and a hit test is a coordinate test:
it rejects a control that is plainly on screen, so `activate` reports an absence rather than a
mis-click. `realClick` does not even get that far.

`saveOpenEdit` clicks the button inside the form, by DOM. **Skipping the hit test is safe there and
would not be in general**: only one message can be in edit mode at a time, so the form is unique on
the page and there is no second candidate - which is the only thing the hit test defends against.
State the uniqueness argument at every site that skips it, or this rule quietly stops holding.

**It became the desktop path too, and not for symmetry.** Left on `realClick`, the browser then
failed MUT-2 with `no stable element for selector: text=Enregistrer` having passed the same step
minutes earlier - `stableCentreOf` samples the geometry twice and the edit form animates in, so the
check was racing a CSS transition to buy a hit test it did not need. The phone's constraint turned
out to name a flake the desktop had been carrying quietly: **when a coordinate buys nothing, it still
costs a race.**

Corollary: **an obstacle attributed to the environment gets checked before it is believed.** MUT-18's
SKIP said A1 was off adb; SESSION STATE had said the opposite for weeks, and the phone was reachable
the whole time. The real obstacle was a missing helper, which nobody went looking for because the
written reason pointed at a cable.

**AND THE TAB IS PART OF THE DEVICE'S IDENTITY, WHICH `find` DOES NOT KNOW.** `client(port, match)`
resolved a client with `targets.find(url.includes(match))` - the FIRST tab whose URL matched, which
is a position, not an identity, and the browsers offer no guarantee about that order. With one app
tab open it is exact; with two it is a coin toss that never announces itself.

Measured 2026-08-16: **W2 was carrying seven `canari-emse.fr` tabs**, and had been for the whole MSG
re-run. A send-and-receive probe attached to one of them, read **6 console lines** from it, and
watched the profile's MLS snapshot counter advance **17 times** in tabs it could not see. W1, on one
tab, was exact throughout - which is the control that makes this the instrument and not the app.

A second tab of the app is **not a variant of the device, it is another device wearing its name**:
same profile, same login, same IndexedDB, its own gateway socket and its own in-memory counters.
Two questions the campaign had already filed as application findings dissolve on that fact:

- **`MSG-9` INVALID, "the receiver never went offline at the gateway"** - `cutHard` closes one tab's
  socket and the user stays present through the other six. The check was right to refuse.
- **Two MSG verdicts PASS-DIRTY on `[MLS] Skipping stale MLS state write (vN <= stored vM)`** - the
  write-if-newer guard in `hex.ts` doing exactly its job against seven MLS clients sharing one
  IndexedDB key, each with its own `_snapshotSeq`. **Nothing is lost when it fires** (the freshest
  snapshot is the one already stored) and on a single-tab client it cannot fire at all: a clean boot
  takes exactly ONE tagged snapshot, measured 48583 -> 48584, zero skips. So it earns **no
  forgiveness rule** - if it is ever seen again on an unambiguous browser, that is a finding.

The fix is at the seam and not at the ninety-six call sites: `client()` **refuses an ambiguous
browser**, naming the count and the paths, and `{ allowMany: true }` is the opt-in for a check that
opened a sibling on purpose. `onetab.mjs` is the repair, and `--dry` exits non-zero so a preflight
cannot ignore it.

**The origin is NOT established, and saying so is the point.** The first account written here - a
one-shot probe that spawned `chrome.exe` beside a live instance, which `startBrowser`'s docstring
says hands its URL to the running browser as a tab - is plausible and was **not** what happened: that
probe waited for the port to stop answering before every relaunch. The obvious successor theory was
measured and refuted too: a force-kill followed by `startBrowser` restores **nothing**, one tab in
and one tab out. What remains is that some path between 14:50 and 15:07 on 2026-08-16 left six
extras, and no capture from that window survives to name it.

That is exactly why the fix is a refusal and a preflight repair rather than a fix to whatever opened
them. **A precondition worth having is one the rig ENFORCES, not one it trusts every caller to
preserve** - the enforcement holds against the cause nobody identified.

The contamination window is bounded, and by the record rather than by memory: `MSG-9` cannot pass on
an ambiguous browser, and it reads PASS on all five passes of the 2026-08-15 series, PASS again at
14:48 on 2026-08-16, `INVALID` at 15:12, and PASS again at 15:35 after the repair. `Skipping stale`
appears nowhere else in `results.ndjson`. One run was affected; the x5 series was not.

#### 6. A MATCHER TESTS ONE SPELLING - and one written from the success wording can only ever report success

Both are the same failure of a matcher: it was written from what the author expected to see, so the outcomes it cannot spell become silence, and silence reads as health.

When a mechanism leaves no trace, a **stale matcher is the right first suspicion** and it is cheap
to rule out: grep the log for every word the mechanism could have used, not for the one string the
check happens to look for. Only once the whole vocabulary is absent does the silence say something
about the application.

Its mirror image: two lines that **no longer exist in the codebase** appearing in a run means the
client is on an old build. Check the deploy before believing anything else that run says.

**A WATCH THAT MATCHES THE SUCCESS WORDING REPORTS ONLY SUCCESS - and silence then reads as health**

The MSG x5 of 2026-08-15 was followed by a live filter over the runner's output, alternating on
`server (clean|NOT)`. The runner prints `  server clean` when a window is clean and
`  SERVER NOT CLEAN - run srvlog.mjs --since ...` when it is not. The alternation is
**case-sensitive**, so it matched every clean window and **none** of the dirty ones: five passes were
reported, four of them said `server clean`, and the fifth said nothing at all. The pass-2 window -
`frontend-ssr NOT CLEAN, unexplained=9` - reached the reader only because the full output was read
by hand afterwards.

The failure is not the regex. It is that **the observer was written from the shape of the outcome it
expected**, and the two outcomes of this runner do not share a spelling: one is lower case, the other
is upper case with a remediation clause appended. A filter derived from the happy path cannot report
the other one, and its silence is indistinguishable from "nothing happened yet".

Applies to any live watch, not just this one: **enumerate the terminal states first, then write the
pattern over all of them.** If you cannot enumerate them, widen rather than narrow - noise costs a
read, a missed failure costs the finding. And the cheapest check on any such filter is to ask what it
would have emitted had the thing being watched crashed at that instant; if the answer is "nothing",
it is not a monitor.

### The state a check needs, before and after

#### 7. A CHECK ESTABLISHES ITS OWN PRECONDITION, and what establishes it belongs in the shared layer

One rule from two directions: a transition destroys preconditions other checks depend on, and a check that assumes one it never established is measuring the previous check's leftovers.

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

**A CHECK MUST ESTABLISH ITS PRECONDITION, AND WHAT ESTABLISHES IT BELONGS IN THE SHARED LAYER**

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
- **A precondition the product cannot reach is not a precondition, it is a fabrication.** MUT-15
  built its "device that lost a pin" by dropping the pin record and restoring
  `history_last_stream_id` / `history_seen_cipher` to the instant before the frame, so the replay
  re-offered a ciphertext this device's MLS ratchet had already consumed. Forward secrecy spends a
  generation's secret at the first successful decrypt: that state exists nowhere in production, and
  the check spent five passes reading MLS's correct refusal as a product defect. The rewind is gone -
  the device is cut with `setOffline` BEFORE the peer pins, which is how a device really comes to
  lack a pin, and the absence is read back before the recovery is polled. The tell is generic: when
  a setup writes storage the application owns, name the sequence of user actions that produces that
  state, and if there is none the check is measuring its own construction.

#### 8. WHEN THE BREAK IS NOT INVERTIBLE, THE TEARDOWN RESTORES A PROPERTY, NEVER A SNAPSHOT - and a cleanup that only runs on the happy path is not a cleanup

The fixture and the teardown are the same object seen from its two ends, and both fail the same way: on the paths where the check did not reach its own last line.

Rewinding a sender cannot be undone by restoring any state: while the fork was live, the peer
consumed generations off it, so **no snapshot is both legitimate and ahead of the peer**. Restoring
one re-creates the very break.

Ask what the next run actually needs - "can this device still deliver?" - and assert that invariant
on every exit path (`ensureDeliverable`). A teardown that only runs on the happy path is not a
teardown.

**A CHECK'S FIXTURE MUST EXIST BEFORE THE SURFACE THAT READS IT - and a cleanup that only runs on the happy path is not a cleanup**

MUT-12 seeds `canari_recent_emojis` so the emoji picker offers fifteen distinct emoji to react with.
It seeded straight after `sendText`, under a comment asserting the picker reads localStorage on its
own first open. **It does not.** `MessageBubble.svelte` renders `MessageEmojiPicker` unconditionally
and only flips its `visible` prop, so that component's `onMount` runs when the **bubble** renders -
which is the instant `sendText` returns. A seed written afterwards could never reach the row the
check is about.

What it produced is the part worth remembering. `MUT-12/dm` threw on its first picker emoji, every
single run. `MUT-12/channel` **PASSED** - because the DM leg threw *before* its own cleanup line and
left the seed in localStorage, where the channel leg's bubble picked it up on mount. One leg was
failing honestly and the other was passing on the first leg's litter, which is strictly worse: on a
fresh profile both fail, and the green row said the opposite. The fix is two lines and two rules: the
fixture goes in **before** the surface exists, and the cleanup goes in a `finally`.

The third lesson is about the sentence. `clickReactionEmoji` threw `no quick-reaction 🎉 on the row`,
which is the same sentence for *the picker never opened* and for *the picker opened with the wrong
list* - and those want opposite fixes (rule 16's shape again). `offeredEmojis` now names what the row
**does** offer, so the next failure of this kind is one line to read.

#### 9. A CHECK THAT REPAIRS THE CLIENT MUST WAIT FOR ITS OWN REPAIR - a single sample right after it measures the instrument

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

The general form, and the reason this is not rule 7 again: rule 7 is about a precondition the check
never ESTABLISHED. Here the precondition was established, correctly, by the check itself - and then
read before the system had finished responding to it. **Anything you did to the client is a
transition; give it the same deadline you would give the application's own.**

### Watching, and what a window means

#### 10. FORGIVING AN EVENT MEANS TAKING IT OUT OF THE GATE, NEVER OUT OF THE RECORD

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

#### 11. A CAP IS NOT A COUNT, AND A SUMMARY AS LONG AS ITS SOURCE IS UNREAD

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

#### 12. AN INSTRUMENT'S OWN LIMIT ARRIVES WEARING THE SYSTEM'S FAULT - and it bites the busiest subject first

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

#### 13. AN OBSERVATION WINDOW MUST KNOW WHETHER ITS SUBJECT WAS REPLACED DURING IT

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

##### The same rule pointed at the CLIENT - where the replacer is the check itself

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
story is rule 14. The harness rule above is unaffected either way: it attributes a close to a counted
document replacement, and a document being replaced still closes its socket however politely it does
so. **`ignoringNavigation` is what actually removed this dirt**, and it was the whole of the fix.

#### 14. A FIX MUST NAME THE OBSERVER WHOSE SIGNAL IT IMPROVES, AND THAT OBSERVER MUST BE ABLE TO SEE IT

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
  "on the new build" without `Page.reload {ignoreCache:true}` is measuring the old one - rule 17 with
  a sharper edge. `bundle-id.mjs` reads the loaded chunk hashes off the resource timeline and answers
  it directly; a fingerprint that comes back EMPTY compares equal to itself and will happily report
  "unchanged" for ever, which is how the first attempt at this reported `INCONCLUSIVE` for a reason
  that was not the true one.

---

#### 15. A DISCRIMINATOR CARRIED IN A LABEL DISCRIMINATES NOTHING - check it against the values that will actually reach it

A report that separates two causes is only worth what its separator is worth, and a separator matched
out of prose is worth nothing until someone proves it fires.

The mailbox barrier refuses a caller while a catch-up session is open, and the two situations it
covers are opposite: the caller is INSIDE that session (a deadlock, fix the call site's order) or
beside somebody else's (not a deadlock at all - it should wait). On 2026-08-15 the refusal was taught
to say which, by matching the caller's label against the open group ids -
`caller.includes(s.groupId)`, "the caller carries its group by convention `<site>:<groupId>`".

**No call site carries one.** All seven pass a bare literal (`'history ask'`, `'outbox flush'`, …),
and only the unit tests ever passed `'history ask:g-abc'` - which is exactly why the tests were green.
So `NESTED` could not be printed in the field at all, every real occurrence read `CONCURRENT`,
and the one sighting on prod the next day (MUT-2, 2026-08-16) read as the benign case by
construction. Had the deadlock recurred, it would have reported itself as "nothing to fix".

Three things this pins, none specific to that barrier:

- **A convention that the code does not enforce is a comment.** `<site>:<groupId>` was documented in
  the same commit that failed to implement it at a single call site.
- **Test the discriminator against the population it will run on**, which is one grep for the call
  sites - the same move as rule 6's watch that matched only the success wording, and the same as the
  fleet-wide `GROUP BY` before believing a predicate.
- **Then carry it as a parameter.** `waitForMessageQueueIdle(caller, catchUpGroupId)` cannot be
  called without deciding, and a value the compiler demands cannot be forgotten at six sites out of
  seven. Same rule as the project's `Never branch on an error MESSAGE`: classify where the fact is
  known, as a type, not where it is being read back out of a sentence.

### Time

#### 16. WAIT FOR THE EVENT, NEVER FOR A DELAY - and a wait that can end two ways must assert the state between them

A delay and an ambiguous wait are the same defect at two moments: the first cannot aim at the event, the second cannot say which event it caught.

A fixed delay has two defects and one of them always lands. **Too short**, it makes "it never
happened" and "it has not happened yet" the same observation - MUT-11 flapped on `sleep(300)` while
the peer's real spread was 157-1453 ms. **Too long**, it charges every run for time in which
everything has already finished, and that cost is paid for ever.

Polling fixes only the first. The condition to wait for is almost always the one the verdict already
asserts, and reaching it IS the finish line:

- MUT-18 waited 15 s for an edit to appear and then slept 3 s for a later edit to overwrite it.
  Rewritten to wait for **convergence itself** - all three clients showing the same body, and that
  body being one of the two edits - it reports `convergedInMs: 22`. The guess was **136x** the
  measurement, on every run, and could still have been too short for a slow peer.
- MUT-12's `reactAndConfirm` and MUT-11's `awaitBadges` are the same move applied to a badge.

**An absence is the one thing that cannot be waited for, only waited out** - and even there, nothing
justifies a constant. Take the bound from the same run's measurement of the thing whose absence is
being asserted, and end early on the event that would refute it:

- MUT-13 proves a self-reaction notifies nobody. It slept 6 s; it now watches for `silenceWindowMs =
  max(1500, 6 x reactorNotifyMs)`, where `reactorNotifyMs` is what the *positive* leg of the same
  check just measured (~156 ms), and it breaks the instant a notify POST appears, because that POST
  is the failure. **The window is recorded in the row**: a bare `0` cannot be judged, `0 over 1500 ms
  when the same request took 156 ms` can.
- NOTIF-9 proves one message raises one notification. Same rewrite: `max(8 s, 2 x notifiedInMs)`
  instead of a flat `sleep(20_000)`, ending the moment a second notification appears.

Two delays are legitimate and must say so where they sit: one that **is** the behaviour under test
(`longPressBubble` holds 700 ms against the app's own 420 ms threshold), and one that paces a poll.

---

**A WAIT THAT CAN END TWO WAYS MUST ASSERT THE STATE BETWEEN THEM - and the SETUP that reaches it is part of the check**

`openChannel` clicked a channel row and waited fifteen seconds for the composer. On pass 4 of 5 of
the TYPE x5 of 2026-08-15 the composer never came, and the report - a good one, carrying the
coordinates, the element that RECEIVED the click, and the screen at both instants - could still only
say that. Two causes end in exactly that state and their fixes are opposite:

- the click was received and never HANDLED, or
- it was handled and the chat area rendered nothing. `ChatArea` renders **nothing at all** - header,
  message list and composer - while its conversation is missing from the store, so a selected channel
  with no entry looks identical to a click that never landed.

A channel selection changes no url either (it is a state assignment), so the address bar cannot
witness it, and fifteen seconds of waiting produce one bit where two are needed. The check now
asserts the intermediate state first - the row becoming `aria-current` - and reports which of the two
sentences applies. **The attribute already existed** for the screen reader, which is the recurring
shape: the affordance that makes a state announceable is the same one that makes it assertable, and
where it is missing, adding it serves both readers.

**And the evidence was absent for a second, independent reason: the setup ran outside the observation
window.** Both `watch` calls opened *after* `openChannel`, so the throw carried one sentence and not a
single console line from either client - on a rig whose whole premise is that observation is part of
every check. A setup that fails IS the check failing. Watch first; `report` already forgives the
navigation the setup performs, by counting `Page.frameNavigated` itself. And a setup failure must
drain those reports into its own record, or the file's top-level handler writes a poorer row over it
and the richer one is the copy nobody finds.

Corollary worth stating on its own: **a re-run is not a recovery.** The next four passes were green,
which recovered nothing - it destroyed the only window in which the fault was visible.

---

### The build under the check

#### 17. DATE THE BUILD BEFORE BELIEVING ANYTHING IT SAYS - and the build's own log strings are the date

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

### The check itself, over time

#### 18. A CHECK IS A CLAIM ABOUT A MECHANISM, AND IT ROTS WHEN THE MECHANISM MOVES

A check is written against the mechanism as it stands. Fix the mechanism and the check does not become stale quietly - it starts asserting the opposite of the product, in a colour nobody rereads.

Two rows here were built to fail on purpose, and both went green-side-up on 2026-08-16 when the
defects they described were fixed. Left alone, each would have asserted the opposite of the product.

**MUT-19 had been DEMOTED and had to be promoted back.** Deleting a message still in the outbox sent
it and then withdrew it, and whether the peer painted the original for one frame was scheduling the
check does not control - measured `false` then `true` within an hour on the same bundle. So the
assertion was moved off `everSawOriginal` and onto the settled state, correctly: a verdict that flaps
says nothing. But the demotion was a property of the DEFECT, not of the check. With the queued entry
withdrawn there is no race left to lose, so a single sighting is now a defect rather than an
accident, and the assertion goes back where it was. **A check softened to survive a defect carries a
debt that comes due with the fix.**

**MUT-21 was worse: it returned `true` unconditionally**, a leftover from the same era, so the hover
bar could have escaped the message pane again behind a green tally. A row that reports `FAIL` and
tallies `ok` is not a compromise, it is a check that has been switched off in one place and left
looking alive in another.

**A SIMULATION IS ONLY FAITHFUL TO THE MECHANISM IT REWINDS - name what it cannot reach**

MUT-15 simulated a fresh device by wiping one `localStorage` key and reloading. That was faithful
while pin state had no other source; the moment it gained one it stopped being a simulation of
anything, because **the device's position in the shared log was still at the head** - it re-read no
frame, so it could not recover anything from the log by construction.

Fixing that turned up a second, sharper constraint: **MLS gives a device no echo of its own frames**,
so a device replaying the log reaches its own `pin` frame and is told `own-message`. A device can
never recover from the log a pin it placed ITSELF. The check therefore had to change *which device
pins* - the peer places it, the device under test receives it - before any amount of rewinding could
help.

The rewind that works is a snapshot: capture the stream cursor and the seen-ciphertext set before the
frame, restore them after. That moves the device back by ONE frame, where deleting the keys would
have re-walked ninety days of a conversation holding thousands of messages on a production account.

And what it still cannot reach is written into the check's own record (`doesNotCover`): the
`history_bundle` half needs a genuine fresh enrolment, which belongs to
[device-verification](device-verification.md). **A check that names its own blind spot is worth more
than one that quietly implies it has none.**

Ordered by how expensive it is to break them.

#### 18b. A VERDICT IS EVIDENCE ONLY FOR THE ASSERTIONS THAT PRODUCED IT - tightening a check retires its previous verdict

Rule 18 is about a check that rots against a moving product. This is its twin, and it bit on
2026-08-20: the check moved and the BOARD did not.

**COMM-5 was recorded `PASS`, and its own row says `liveWithoutReload: false`.** At the moment of
that run the row asked only that a promoted member gain the capability eventually, so a reload was
allowed to be what delivered it and the record kept the live figure beside the verdict without
asserting on it. `capabilityIsLive` was added to its expectations afterwards, the runner was never
re-run, and the board went on showing a green row earned under a weaker question.

The cost was not theoretical. That recorded `false` WAS the defect found fifteen hours later - four
`workspace.*` events dropped by both socket clients - sitting in the results file, under a `PASS`,
where nothing would ever look at it again.

**So a row now names the check it ran as** (`check`, `checkSha` in `results.mjs`), exactly as it
already names the build it ran against, and "this verdict predates the current runner" is computed
rather than remembered. The hash covers the ENTRY script, where a check's own assertions live; a
change to a shared gesture in `comm.mjs` is not covered, and that limit is written down in the code
rather than assumed away.

**Reading it is the discipline the field only enables:** before believing a green row, compare its
`checkSha` with the runner on disk. A verdict whose check has changed is not a weaker verdict - it is
a verdict about a different question.

#### 19. A SCRIPT OWNS A FEW CHECKS, AND EVERY CHECK IS INDEPENDENT - the two halves of one rule

Standing instruction from the user, and it governs every phase: *"C'est bien de faire des scripts pour
un nombre limité de tests à la fois plutôt que pour tous les tests de la phase"*, and *"Un test doit
être indépendant. S'il est indépendant, il pourra aussi être fait les uns à la suite des autres"*.

**The granularity half.** A file that owns a whole phase fails as one unit. One throw in check three
takes checks four to twelve with it, and they had nothing to do with the failure - which is how a
phase reports one defect and eleven silences. The campaign has paid this twice in one week: three
scripts exiting non-zero having recorded nothing at all, and a run where a single `armComposer` throw
cost every verdict downstream of it in the same file.

**The independence half is what makes the granularity possible**, and it is the stronger claim. A
check establishes its own precondition, asserts nothing another check had to arrange, and leaves the
clients in a state the next one can start from. The test of it is not "does the phase pass" - it is
**does this check pass ALONE, and does it pass in any position**. MSG-8b passing standalone while
failing inside its phase is exactly the reading that is only available when checks are independent;
without it the failure is a property of the file and cannot be attributed at all.

Two corollaries the campaign already learnt the expensive way, now stated as consequences of this
rule rather than as separate lessons: a check that leaves an overlay, a backgrounded page or an extra
tab behind has broken the independence of every check after it (rules 7 and 8), and a check that
passes on the previous check's litter is strictly worse than one that fails honestly - on a fresh
profile both fail, and the green row said the opposite.

**Sequence is then a convenience, never a requirement.** The ladder's order exists because each rung
is easier to interpret once the one below it holds, not because a rung needs the previous one's
leftovers.

#### 20. RESIDUE A CHECK LEAVES IS A CLAIM ABOUT THE APP BEFORE IT IS A CLAIM ABOUT THE CHECK - and it is settled by re-running the check, not by reasoning about the dates

`recon.mjs` reported four messages one device held and no other did: the shape of a real loss, on
production, on the sender's side. The tempting reading was debris - MUT-19 deliberately strands a
message, so "the harness made them" would have closed the entry and bought a teardown. The dates
argued AGAINST it (the four were spread over 90 minutes, MUT-19's five runs fitted in 30), and that
argument was worth nothing in both directions: it could neither convict nor acquit.

**The causal test settles in one run what the timeline cannot settle at all.** One
`mut.mjs --only 19`, one re-measure: four became five, at the minute of the run. Attribution, not
inference - and it costs less than the reasoning it replaces.

Then the part that matters more: **the residue was the defect.** The check was doing exactly what a
user does, and the row it left behind was the application's own durable answer to it - a tombstone
for a message no peer had ever received. Writing a teardown would have deleted the evidence of a
live bug and made the instrument permanently blind to that whole class. So the order is fixed: find
out WHY the state is there, and only then decide whether anything should clean it up. A teardown is
correct only for state the check creates that the application would never have created itself.

The corollary for the instrument: a check that can leave the app in a state another instrument reads
as a defect must ASSERT that state itself. MUT-19 now reads the sender's store, because on screen a
dropped row and a tombstone are indistinguishable - the discriminator is at rest, and only a check
that goes to look can carry it.

#### 21. A RULE THE HARNESS WRITES IN PROSE IS A RULE THE HARNESS WILL BREAK - the seam that can refuse is where it belongs

`goto()` had carried **"DO NOT USE ON A1"** in its own doc comment for weeks, with the reason spelt
out. Three call sites did it anyway - `openDM`, `openChannel`, and NOTIF-7 deliberately - because a
comment is read once, by whoever is writing that function, and never again by the caller two files
away.

**What it cost was a defect attributed to the application.** MUT-18 went PASS-DIRTY on A1 with
`Uncaught TypeError: Cannot read properties of undefined (reading 'runCallback')` at `(no url):1:28`,
three times, and it sat in SESSION STATE as *not yet attributed to the harness or to the app*. It is
the harness, and the column number proves it: Tauri delivers every command error and every scalar
response by having Rust EVALUATE `window.__TAURI_INTERNALS__.runCallback(...)` into the page
(`format_raw_js`, tauri 2.11), and character 28 of that string is exactly where `runCallback` is read
off `window.__TAURI_INTERNALS__`. So the object was undefined - the document had been replaced under
an in-flight IPC call, by the harness's own `Page.navigate`. No script URL, because the script was
evaluated from outside the page: the frame said so all along, once `watch.mjs` started printing it.

The fix is not a fourth comment. `goto` now **refuses** A1 unless the caller passes
`{ relaunch: 'why' }`, `openDM` takes the click path there, and the one remaining reload declares
itself in a word that can be grepped. A rule that can be enforced at a seam belongs at that seam;
prose is what you write when it cannot be.

#### 22. A TEST FILE NOBODY EXECUTES READS AS COVERAGE ON EVERY REVIEW - check the file COUNT, not the colour

Sky's `tests/api.test.ts` was neither passing nor failing for months: the vitest `include` only ever
looked under `src/`, so the runner never found it. It had rotted meanwhile - a mock missing an export
the route calls, and an env assignment placed after a hoisted import - so every case would have
answered 500 had it ever run. Nothing announces this. **A green suite says only that the files it
FOUND passed**, and a reviewer reading the tree sees a covered surface.

So whenever a suite lives outside the pattern's roots, or a runner's `include` / `testMatch` is
edited, read the reported file and case COUNT and compare it to what is on disk. The same instrument
answers the general form of the question: a check that never ran and a check that passed are the same
colour, and only the count separates them.

#### 23. CODE THAT LEAVES THIS PROCESS IS DATA WHILE IT IS HERE - and its escapes are read on the way out

Every expression this rig runs in a browser is built as a template literal and handed to CDP as a
string. Node reads the escapes before CDP ever sees it: `\r` leaves as a carriage return, `\s` leaves
as the bare letter `s`. The same is true of a pattern handed to `new RegExp`. **The backslash belongs
to whoever parses the string LAST, and a template literal is not that parser.**

Four sites had it on 2026-08-20, and the pair of failure modes is the whole lesson:

- `chat.mjs`'s `HEADER_NAME` carried `/[\r\n]+/`, which reached the page as a regex literal cut in
  half by a real newline. `evaluate` threw `SyntaxError: Invalid regular expression: missing /` on
  **every** call, so `ensureConversation` - the single thing that names which conversation is open -
  did not run at all. **It was written correctly and halved by an edit AROUND it**: doubled since
  `29ee5d8c`, single from `614bddbd` three hours before it was found, a commit that rewrote `PANE`
  and re-typed the lines beside it. A doubled backslash reads like a typo to whoever touches the
  region next, which is why the rule cannot live in the escaping and has to live in `String.raw`.
- `nav.mjs`, `synopen.mjs` and `comm8.mjs` carried `/\s+/` and `` `\[GRAINE\] seed \S+ ...` ``, which
  reach their parser as `/s+/` and `[GRAINE] seed S+ ...` - valid, sane-looking, and asking a
  different question. SILENT. `comm8`'s reading of "the peer's own device never announced a seed for
  this salon" **could not say yes**, and said no under a recorded verdict.

The silent half is the dangerous one and it is the argument for the fix: `String.raw` forwards the
literal parts verbatim, interpolates `${...}` exactly as before, and makes the shape immune by
construction instead of by vigilance. `rawcheck.mjs` keeps it that way, exits non-zero, and was
validated as a negative control against all four sites before its clean verdict was believed - see
rule 12. It reports only templates that are page-side expressions or go straight into `RegExp`,
because a check that also flags a `\n` in a console banner is a check whose reader learns to skip it.

**The general form outlives this rig:** whenever a string is authored in one language to be parsed by
another - a page-side expression, a regex built from a template, a shell command assembled in Node,
an SQL statement assembled in a shell - name which parser reads it last, and confirm the escapes
survive the trip. Confirm by RUNNING it, not by reading it: all four sites read correctly to four
separate reviews.

#### 24. A SEARCH THAT WALKS OUTWARD FINDS A CONTAINER - bound what it may land on, or it counts the list as an item

COMM-4 counts invitation cards, and a card has no test id: it is found by its description, then by
walking up to the nearest ancestor that also carries THIS run's community name. That ancestor is the
card - for the card the run just produced. For the five cards **previous runs** left in the same
conversation, the nearest ancestor carrying this run's name is the container holding all six, and it
was counted as a second card. Measured on the live screen: six descriptions in the pane, five of them
landing on one shared ancestor, one landing on a real card one level up.

So COMM-4 reported two cards where the store holds one row, on both devices, and had done so on every
run. **The check's own residue is what fed it** - rule 20's other edge: residue does not only make a
check flaky, it can make a check's WAY OF LOOKING wrong in a way an empty venue would never reveal.

The fix is a bound the search can assert: an ancestor is a card only if it holds exactly ONE
description. A container holds six, and says so.

That run's other half is worth the same sentence. The invitee's card counted ZERO because the check
looked for its expected wording, rebuilt by filling `msg_channel_invite_description_by` with the name
in `names.mjs` - which is what the SIDEBAR is searched by, a first name, while the card is worded with
what the profile resolves to. Two different questions, one string, and the answer was "no card". A
rendered message is now matched by its LITERAL parts with anything at the placeholders
(`saysMessage`), which also tells the three invitation wordings apart, and no display name is spelt
in the repository to do it.

**Both faults pointed at the product and neither was in it**, and they hid each other: fixing the
wording turned the invitee's 0 into a 2, which read as a NEW duplication defect rather than as the
container artefact that had been there all along. A count that disagrees with the store is a question
about the instrument first - the store had one row per invitation on both devices, with the
deterministic id and no twin, before any of this was believed.

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

### AND IT APPLIES TO EVERY CHECK OF EVERY PHASE - which was measured, and was not true

Set by the user on 2026-08-16, after `NOTIF-10` reported `PASS` over a phone that had been raising
generic "Nouveau message de X" notifications: *"il faut que dans TOUTES les phases de TOUTE la
campagne, il faut que tout soit mesure ... nous devons etre extremement precis et TOUT verifier."*

The rule above was already written, and the harness was audited against it the same day rather than
assumed to follow it. It did not. **Twelve phases, three different behaviours:**

| | Phases | What actually happened |
| --- | --- | --- |
| Observed **and** gated | MSG (11 scripts), TYPE, READ, MUT, FWD-3/4/5 | the bar, enforced |
| Recorded, never gated | FWD-1/2, TAB-4, TAB-5, HEAL-W2, **SEARCH (6 checks)**, **MENTION (6 checks)** | the report printed **under** the verdict, where it could be read but never contradict it |
| Recorded **nothing at all** | NOTIF, NOTIF7, FWD-5, LIFE, TAB-2/3/6, HEAL, HEAL-A1, HEAL-WEB, GRP | a verdict computed, printed as JSON, and absent from `results.ndjson` - so `run.mjs` printed `done` |

SEARCH, MENTION and GRP - the three phases queued to run next - had **no observer at all**:
`watch = 0`, `report = 0`. Twelve verdicts between them, resting on nobody looking. That is the exact
fault READ shipped eight passes on, and `mut.mjs` was rewritten for, reappearing in the phases nobody
had rewritten yet.

**THE REPAIR IS NOT THIS PARAGRAPH.** A rule saying "gate every check" is the rule that was already
stated at the top of this section, and it was forgotten in seven scripts by authors who had read it.
An omission of MEMORY is not fixed by a second thing to remember - the same reasoning `results.mjs`
already carries for the exit code. So the refusal lives in the two places that cannot be bypassed:

- **`record()` demotes a `PASS` that carries no gated report to `UNOBSERVED`.** `gate()` is the only
  producer of `clean`, so its presence in the detail IS the proof an observation happened. A check
  that genuinely cannot observe must say so as a written sentence (`unobservable: '<why>'`), which is
  a decision in the record rather than an absence in it. `UNOBSERVED` is deliberately distinct from
  `PASS-DIRTY`: "nobody looked" and "someone looked and it was dirty" send their reader to different
  places, and both exit non-zero through the `beforeExit` derivation that already existed.
- **`run.mjs` counts the rows each job wrote and reports a job that exited 0 having written none.**
  `results.mjs` can only see the rows a process wrote, never the rows it owed; the runner is the only
  observer that knows a script was supposed to speak. A silent job now counts against the pass,
  because a phase claiming coverage its record cannot support is the same debt as a dirty window.

**The three surfaces were at three different levels of rigour, and the phone was the lowest.** The
server has a full classifier with a per-rule self-test; the web has `report()`'s buckets; the phone
had a **keyword grep** - `/\bE\b|FATAL|Exception|...|fail|error/i` over raw logcat. Measured against a
real 2 627-line capture, that predicate marks 43 lines that are not Canari's at all: 39 from the
WebView's own Chrome-Sync subsystem, and four `Could not create Worker com.linkedin.android...` from
**a different application on the device**. Gating on it would have made the phone permanently dirty,
which is dirt nobody reads. The phone's own native tags are a small, structured population - 25
distinct shapes across the captures, all `D/` or `I/` - so it is classifiable exactly like the other
two, with everything foreign COUNTED rather than judged. See {@link watch.mjs}'s `logcatReport`.

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
kept in the record, per rule 10.

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

**DECIDED 2026-08-18 (the user): `call-service` gets that logging BEFORE the twenty CALL scripts are
written** - invite, answer, ICE candidate exchange, hangup, duration. The argument is the paragraph
above it: a call has two halves and each client sees only its own, so a failed call is exactly the
shape of result nothing on either side can attribute. The same reasoning found the silent channel
push 404s, which had been failing on every channel message and which no client-side observation
could have surfaced. **Twenty scripts standing on no observer would produce twenty results none of
which could be believed**, which is not a cheaper campaign, it is a longer one.

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
- **A LOCKED PHONE IS A LIVE APP THAT IS NOT CONNECTED, and the window it focuses is called
  `NotificationShade`.** On 2026-08-15 the READ preflight stopped on `A1 OFFLINE` while the same
  preflight had just reported the app unlocked with its ten conversations on screen. `dumpsys window`
  said `mCurrentFocus=Window{... NotificationShade}` - which reads as "somebody left the shade pulled
  down" and is in fact the keyguard, that being the window it is drawn in. Two further readings that
  look like contradictions and are not: `am start` answers *"intent has been delivered to currently
  running top-most instance"*, because the activity really is top-most with the keyguard over it; and
  the socket is gone because the webview went `hidden` and the native foreground guard released it,
  which is the design, not a reconnect failure. `input keyevent`, `cmd statusbar collapse` and a
  swipe all fail against a keyguard; `wm dismiss-keyguard` clears it when there is no credential to
  enter, and presence returns within seconds. **`svc power stayon usb` does not prevent this** - it
  keeps the screen on, it does not keep the device unlocked.
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
